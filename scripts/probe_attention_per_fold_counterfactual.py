#!/usr/bin/env python3
"""Candidate-erased normalization for per-fold conditional expansion utility."""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_contrastive as contrastive
import probe_attention_per_fold_utility as per_fold
import probe_attention_selective as selective
import probe_attention_shadow as attention
import probe_attention_utility as utility


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-per-fold-candidate-erased-utility-v1"
POLICY_ID = "zero-false-candidate-erased-fold-expansion-event-v1"
CONFIDENCE_SCALAR = (
    "maximum per-fold actual expand-minus-skip margin minus candidate-erased margin"
)
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
MINIMUM_COUNTERFACTUAL_THRESHOLD = 0.0
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = per_fold.fixture_contract(fixture)
    return {
        **base,
        "scorerId": SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "interruptWhen": (
            "the largest nonnegative candidate-erased utility lift meets or exceeds the "
            "frozen threshold"
        ),
        "candidateAction": (
            "expand exactly the fold with the largest candidate-erased conditional utility lift"
        ),
        "forwardsPerDecision": (
            "two independent local-model forwards per supplied fold, actual then equal-token "
            "candidate-erased; the count varies with the complete standing fold set"
        ),
        "ranker": None,
        "normalization": {
            "actual": "the complete fold expansion appears in the frozen per-fold prompt",
            "control": (
                "replace every token id whose character span overlaps candidate content with "
                "one ordinary neutral token id while preserving input length, attention mask, "
                "and every noncandidate token position"
            ),
            "tokenBoundary": (
                "a tokenizer token that also carries adjacent delimiter whitespace belongs to "
                "the candidate erasure and is counted in the report"
            ),
            "score": (
                "actual expand-minus-skip margin minus candidate-erased expand-minus-skip margin"
            ),
            "minimumEligibleThreshold": MINIMUM_COUNTERFACTUAL_THRESHOLD,
        },
        "jointCorrectOffer": (
            "the winning fold has nonnegative candidate-erased lift, is necessary now, and is "
            "relevant to the current task"
        ),
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "minimumThreshold": MINIMUM_COUNTERFACTUAL_THRESHOLD,
            "selection": (
                "lowest nonnegative counterfactual threshold with zero false offers and the "
                "most offers"
            ),
        },
        "boundary": (
            "offline selector experiment only; no carrier, Pi event registration, context "
            "mutation, threshold promotion, active-context nomination, quantization, batching, "
            "prompt rewrite, model swap, or latency optimization"
        ),
    }


def build_prompt_text(
    tokenizer: Any,
    fold: dict[str, Any],
    case: dict[str, Any],
) -> dict[str, Any]:
    system = (
        "Act as a conservative context-expansion gate. Decide whether exposing this single "
        "folded span is warranted for the current task. Choose expand only when the active "
        "context is insufficient, this fold directly supplies necessary missing evidence, and "
        "exposing it would materially advance the task. Choose skip when the fold is irrelevant, "
        "merely topical, redundant with active context, or unnecessary to complete the task. "
        "False expansions are worse than missed expansions. Fold depth does not imply importance. "
        "Reply with exactly expand or skip."
    )
    parent = fold["parentFoldId"] if fold["parentFoldId"] is not None else "root"
    prefix = (
        f'<EVENT kind="{case["eventKind"]}">\n'
        "This snapshot was taken immediately after this event boundary.\n"
        "</EVENT>\n\n<ACTIVE_CONTEXT>\n"
        f'{case["activeContext"]}\n'
        "</ACTIVE_CONTEXT>\n\n<CURRENT_TASK>\n"
        f'{case["task"]}\n'
        "</CURRENT_TASK>\n\n<CANDIDATE_FOLD "
        f'id="{fold["foldId"]}" parent="{parent}" depth="{fold["depth"]}">\n'
    )
    suffix = (
        "\n</CANDIDATE_FOLD>\n\n"
        "If this fold were expanded into active context now, would it provide necessary missing "
        "evidence that warrants interrupting the agent?"
    )
    content = fold["expandedContent"]
    user = prefix + content + suffix
    rendered = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    user_start = rendered.find(user)
    refuse(user_start >= 0, "attention-counterfactual-chat-template-lost-user-content")
    refuse(
        rendered.find(user, user_start + 1) < 0,
        "attention-counterfactual-chat-template-duplicated-user-content",
    )
    content_start = user_start + len(prefix)
    content_end = content_start + len(content)
    refuse(
        rendered[content_start:content_end] == content,
        "attention-counterfactual-candidate-span-mismatch",
    )
    return {
        "fullPrompt": rendered + "Decision:",
        "candidateStart": content_start,
        "candidateEnd": content_end,
    }


def prepare_paired_fold_prompt(
    tokenizer: Any,
    fold: dict[str, Any],
    case: dict[str, Any],
    neutral_token_id: int,
) -> dict[str, Any]:
    built = build_prompt_text(tokenizer, fold, case)
    full_prompt = built["fullPrompt"]
    encoded = tokenizer(
        full_prompt,
        add_special_tokens=False,
        truncation=False,
        return_offsets_mapping=True,
        return_tensors="pt",
    )
    offsets = [tuple(pair) for pair in encoded.pop("offset_mapping")[0].tolist()]
    candidate_tokens = attention.overlapping_token_positions(
        offsets,
        built["candidateStart"],
        built["candidateEnd"],
    )
    refuse(
        bool(candidate_tokens),
        f"attention-counterfactual-empty-candidate-token-span:{fold['foldId']}",
    )
    refuse(
        offsets[candidate_tokens[0]][0] <= built["candidateStart"]
        and offsets[candidate_tokens[-1]][1] >= built["candidateEnd"]
        and all(
            offsets[left][1] == offsets[right][0]
            for left, right in zip(candidate_tokens, candidate_tokens[1:])
        ),
        f"attention-counterfactual-candidate-token-coverage-gap:{fold['foldId']}",
    )
    boundary_crossing_tokens = sum(
        offsets[position][0] < built["candidateStart"]
        or offsets[position][1] > built["candidateEnd"]
        for position in candidate_tokens
    )
    legacy = per_fold.prepare_fold_prompt(tokenizer, fold, case)
    refuse(
        legacy["promptSha256"] == attention.sha256_text(full_prompt)
        and legacy["encoded"]["input_ids"].tolist() == encoded["input_ids"].tolist()
        and legacy["encoded"]["attention_mask"].tolist()
        == encoded["attention_mask"].tolist(),
        f"attention-counterfactual-actual-prompt-drift:{fold['foldId']}:{case['id']}",
    )
    erased_encoded = {key: value.clone() for key, value in encoded.items()}
    erased_encoded["input_ids"][0, candidate_tokens] = neutral_token_id
    refuse(
        erased_encoded["input_ids"].shape == encoded["input_ids"].shape
        and erased_encoded["attention_mask"].tolist()
        == encoded["attention_mask"].tolist(),
        "attention-counterfactual-erased-geometry-drift",
    )
    refuse(
        all(
            int(erased_encoded["input_ids"][0, position]) == neutral_token_id
            for position in candidate_tokens
        ),
        "attention-counterfactual-candidate-erasure-incomplete",
    )
    refuse(
        all(
            int(erased_encoded["input_ids"][0, position])
            == int(encoded["input_ids"][0, position])
            for position in range(encoded["input_ids"].shape[1])
            if position not in set(candidate_tokens)
        ),
        "attention-counterfactual-noncandidate-token-changed",
    )
    return {
        "actualEncoded": encoded,
        "erasedEncoded": erased_encoded,
        "promptSha256": attention.sha256_text(full_prompt),
        "actualInputSha256": attention.sha256_text(
            json.dumps(encoded["input_ids"][0].tolist(), separators=(",", ":"))
        ),
        "erasedInputSha256": attention.sha256_text(
            json.dumps(erased_encoded["input_ids"][0].tolist(), separators=(",", ":"))
        ),
        "inputTokens": int(encoded["input_ids"].shape[1]),
        "candidateTokens": len(candidate_tokens),
        "boundaryCrossingTokens": boundary_crossing_tokens,
        "candidateChars": len(fold["expandedContent"]),
        "candidateContentSha256": attention.sha256_text(fold["expandedContent"]),
        "legacyPromptMatched": True,
    }


def counterfactual_values(
    actual: dict[str, float | str],
    erased: dict[str, float | str],
) -> dict[str, Any]:
    actual_margin = float(actual["utilityMargin"])
    erased_margin = float(erased["utilityMargin"])
    return {
        "actual": actual,
        "candidateErased": erased,
        "counterfactualUtilityMargin": actual_margin - erased_margin,
    }


def ranked_folds(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(
        rows,
        key=lambda row: (-row["counterfactualUtilityMargin"], row["id"]),
    )
    return [{**row, "rank": rank} for rank, row in enumerate(ranked, start=1)]


def prepare_split(
    tokenizer: Any,
    split_name: str,
    split: dict[str, Any],
    context_tokens: int,
    neutral_token_id: int,
) -> list[dict[str, Any]]:
    folds_by_id = {fold["foldId"]: fold for fold in split["folds"]}
    fold_ids = list(folds_by_id)
    orders = attention.rotations(fold_ids)
    prepared = []
    for case in utility.expanded_cases(split):
        order = orders[case["rotation"]]
        prompts = []
        for fold_id in order:
            prompt = prepare_paired_fold_prompt(
                tokenizer,
                folds_by_id[fold_id],
                case,
                neutral_token_id,
            )
            refuse(
                prompt["inputTokens"] <= context_tokens,
                f"attention-counterfactual-input-exceeds-model-context:{split_name}:"
                f"{case['id']}:{fold_id}:{prompt['inputTokens']}:{context_tokens}",
            )
            prompts.append({"foldId": fold_id, "prompt": prompt})
        refuse(
            len(prompts) == len(fold_ids)
            and {row["foldId"] for row in prompts} == set(fold_ids),
            f"attention-counterfactual-did-not-measure-every-fold:"
            f"{split_name}:{case['id']}",
        )
        prepared.append({"case": case, "order": order, "prompts": prompts})
    return prepared


def run_prepared_split(
    torch: Any,
    model: Any,
    device: str,
    split_name: str,
    prepared: list[dict[str, Any]],
    token_ids: dict[str, int],
) -> tuple[list[dict[str, Any]], dict[str, float | int]]:
    trials = []
    totals: dict[str, float | int] = {
        "actualForwardSeconds": 0.0,
        "candidateErasedForwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    for index, item in enumerate(prepared, start=1):
        decision_started = time.perf_counter()
        case = item["case"]
        folds = []
        for prompt_row in item["prompts"]:
            prompt = prompt_row["prompt"]
            actual, actual_seconds = per_fold.score_fold_once(
                torch,
                model,
                prompt["actualEncoded"],
                device,
                token_ids,
            )
            erased, erased_seconds = per_fold.score_fold_once(
                torch,
                model,
                prompt["erasedEncoded"],
                device,
                token_ids,
            )
            totals["actualForwardSeconds"] += actual_seconds
            totals["candidateErasedForwardSeconds"] += erased_seconds
            totals["forwardPasses"] += 2
            folds.append({
                "id": prompt_row["foldId"],
                "promptSha256": prompt["promptSha256"],
                "actualInputSha256": prompt["actualInputSha256"],
                "erasedInputSha256": prompt["erasedInputSha256"],
                "inputTokens": prompt["inputTokens"],
                "candidateTokens": prompt["candidateTokens"],
                "boundaryCrossingTokens": prompt["boundaryCrossingTokens"],
                "candidateChars": prompt["candidateChars"],
                "candidateContentSha256": prompt["candidateContentSha256"],
                "legacyPromptMatched": prompt["legacyPromptMatched"],
                "actualForwardSeconds": actual_seconds,
                "candidateErasedForwardSeconds": erased_seconds,
                **counterfactual_values(actual, erased),
            })
        ranked = ranked_folds(folds)
        decision_seconds = time.perf_counter() - decision_started
        totals["decisionSeconds"] += decision_seconds
        winner = ranked[0]
        trials.append({
            "caseId": case["id"],
            "class": case["class"],
            "eventKind": case["eventKind"],
            "rotation": case["rotation"],
            "order": item["order"],
            "themeFoldId": case["themeFoldId"],
            "relevantFoldIds": case["relevantFoldIds"],
            "activeContextSha256": attention.sha256_text(case["activeContext"]),
            "taskSha256": attention.sha256_text(case["task"]),
            "winnerId": winner["id"],
            "winnerCounterfactualMargin": winner["counterfactualUtilityMargin"],
            "decisionSeconds": decision_seconds,
            "folds": ranked,
        })
        if index % 4 == 0 or index == len(prepared):
            print(
                f"attention counterfactual {split_name}: {index}/{len(prepared)} events",
                file=sys.stderr,
                flush=True,
            )
    return trials, totals


def decision_row(trial: dict[str, Any]) -> dict[str, Any]:
    winner = min(trial["folds"], key=lambda row: row["rank"])
    relevant = set(trial["relevantFoldIds"])
    return {
        "caseId": trial["caseId"],
        "class": trial["class"],
        "eventKind": trial["eventKind"],
        "winnerId": winner["id"],
        "confidence": winner["counterfactualUtilityMargin"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [
        point for point in sweep
        if point["threshold"] >= MINIMUM_COUNTERFACTUAL_THRESHOLD
        and point["offers"] >= MIN_DEVELOPMENT_OFFERS
        and point["precision"] == DEVELOPMENT_REQUIRED_PRECISION
    ]
    selected = max(
        eligible,
        key=lambda point: (point["offers"], -point["threshold"]),
    ) if eligible else None
    return {
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "minimumThreshold": MINIMUM_COUNTERFACTUAL_THRESHOLD,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def self_test() -> dict[str, Any]:
    actual = per_fold.utility_values(5.0, 1.0)
    erased = per_fold.utility_values(4.5, 1.5)
    values = counterfactual_values(actual, erased)
    refuse(
        values["counterfactualUtilityMargin"] == 1.0,
        "attention-counterfactual-subtraction-self-test-failed",
    )
    ranked = ranked_folds([
        {"id": "z-fold", "counterfactualUtilityMargin": 0.8},
        {"id": "a-fold", "counterfactualUtilityMargin": 0.8},
        {"id": "low-fold", "counterfactualUtilityMargin": -0.4},
    ])
    refuse(
        [row["id"] for row in ranked] == ["a-fold", "z-fold", "low-fold"],
        "attention-counterfactual-deterministic-ranking-self-test-failed",
    )
    decisions = [
        {"caseId": "a", "class": "positive", "confidence": 0.9,
         "correct": True, "opportunity": True},
        {"caseId": "b", "class": "positive", "confidence": 0.8,
         "correct": True, "opportunity": True},
        {"caseId": "c", "class": "positive", "confidence": 0.7,
         "correct": True, "opportunity": True},
        {"caseId": "d", "class": "positive", "confidence": 0.6,
         "correct": True, "opportunity": True},
        {"caseId": "e", "class": "already-visible", "confidence": 0.5,
         "correct": False, "opportunity": False},
    ]
    selected = calibrate_threshold(decisions)["selected"]
    refuse(
        selected is not None
        and selected["threshold"] == 0.6
        and selected["offers"] == 4
        and selected["falseOffers"] == 0,
        "attention-counterfactual-calibration-self-test-failed",
    )
    negative_only = [
        {**row, "confidence": row["confidence"] - 2.0}
        for row in decisions[:4]
    ]
    refuse(
        calibrate_threshold(negative_only)["selected"] is None,
        "attention-counterfactual-negative-threshold-self-test-failed",
    )
    wrong_fold_trial = {
        "caseId": "wrong-fold",
        "class": "positive",
        "eventKind": "stop",
        "relevantFoldIds": ["right"],
        "folds": [
            {"id": "wrong", "counterfactualUtilityMargin": 4.0, "rank": 1},
            {"id": "right", "counterfactualUtilityMargin": 3.0, "rank": 2},
        ],
    }
    refuse(
        decision_row(wrong_fold_trial)["correct"] is False,
        "attention-counterfactual-wrong-fold-self-test-failed",
    )
    return {
        "counterfactualUtilityMargin": values["counterfactualUtilityMargin"],
        "rankedFoldIds": [row["id"] for row in ranked],
        "threshold": selected["threshold"],
        "offers": selected["offers"],
        "falseOffers": selected["falseOffers"],
        "negativeThresholdRefused": True,
        "wrongFoldOnPositiveIsFalse": True,
    }


def not_run_validation(fixture: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "not-run-no-development-threshold",
        "eventSnapshots": len(utility.expanded_cases(fixture["splits"]["validation"])),
        "offers": None,
        "falseOffers": None,
        "precision": None,
        "recall": None,
        "confirmed": False,
    }


def run_live(
    args: argparse.Namespace,
    fixture: dict[str, Any],
    fixture_path: Path,
) -> dict[str, Any]:
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(
        args.device in {"cuda", "cpu"},
        "attention-counterfactual-device-must-be-cuda-or-cpu",
    )
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-counterfactual-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-counterfactual-needs-fast-tokenizer-offsets",
    )
    token_ids = per_fold.choice_token_ids(tokenizer)
    neutral_text, neutral_token_id = contrastive.choose_neutral_token(tokenizer)
    development_prepared = prepare_split(
        tokenizer,
        "development",
        fixture["splits"]["development"],
        config.max_position_embeddings,
        neutral_token_id,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        dtype=dtype,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).to(args.device).eval()
    load_finished = time.perf_counter()
    development_trials, development_times = run_prepared_split(
        torch,
        model,
        args.device,
        "development",
        development_prepared,
        token_ids,
    )
    development_decisions = [decision_row(trial) for trial in development_trials]
    calibration = calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(
        development_decisions,
        MINIMUM_COUNTERFACTUAL_THRESHOLD,
    )
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "actualForwardSeconds": 0.0,
        "candidateErasedForwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    if selected is None:
        validation = not_run_validation(fixture)
    else:
        validation_prepared = prepare_split(
            tokenizer,
            "validation",
            fixture["splits"]["validation"],
            config.max_position_embeddings,
            neutral_token_id,
        )
        validation_trials, validation_times = run_prepared_split(
            torch,
            model,
            args.device,
            "validation",
            validation_prepared,
            token_ids,
        )
        validation_decisions = [decision_row(trial) for trial in validation_trials]
        validation = selective.decision_metrics(
            validation_decisions,
            selected["threshold"],
        )
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= MIN_DEVELOPMENT_OFFERS
            and validation["falseOffers"] == 0
        )
    executed_trials = development_trials + validation_trials
    total_times = {
        key: development_times[key] + validation_times[key]
        for key in development_times
    }
    folds = [fold for trial in executed_trials for fold in trial["folds"]]
    input_tokens = [fold["inputTokens"] for fold in folds]
    candidate_tokens = [fold["candidateTokens"] for fold in folds]
    boundary_crossing_tokens = [fold["boundaryCrossingTokens"] for fold in folds]
    total_forward_seconds = (
        total_times["actualForwardSeconds"]
        + total_times["candidateErasedForwardSeconds"]
    )
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": (
            "candidate-erased normalization of per-fold conditional expansion utility"
        ),
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "frozenPromptScriptSha256": attention.sha256_file(
                Path(per_fold.__file__).resolve()
            ),
            "fixtureLoaderScriptSha256": attention.sha256_file(
                Path(utility.__file__).resolve()
            ),
            "neutralTokenChooserScriptSha256": attention.sha256_file(
                Path(contrastive.__file__).resolve()
            ),
            "policyScriptSha256": attention.sha256_file(
                Path(selective.__file__).resolve()
            ),
        },
        "model": {
            "id": args.model,
            "revision": getattr(config, "_commit_hash", None),
            "parametersDtype": str(next(model.parameters()).dtype),
            "layers": int(model.config.num_hidden_layers),
            "attentionHeads": int(model.config.num_attention_heads),
            "contextTokens": int(config.max_position_embeddings),
            "attentionImplementation": "eager",
            "quantized": False,
            "generatedTokens": 0,
        },
        "scorer": {
            "id": SCORER_ID,
            "expandTokenText": per_fold.EXPAND_CHOICE,
            "expandTokenId": token_ids["expand"],
            "skipTokenText": per_fold.SKIP_CHOICE,
            "skipTokenId": token_ids["skip"],
            "neutralTokenText": neutral_text,
            "neutralTokenId": neutral_token_id,
            "confidenceScalar": CONFIDENCE_SCALAR,
            "allFoldNodesMeasured": True,
            "separateConditionalPromptPerFold": True,
            "actualPromptByteIdenticalToPriorScorer": True,
            "equalTokenCandidateErasure": True,
            "generatedTokens": 0,
        },
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "device": args.device,
            "cuda": torch.version.cuda if args.device == "cuda" else None,
            "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
            "offline": args.offline,
            "loadSeconds": load_finished - load_started,
            **total_times,
            "executedDecisions": len(executed_trials),
            "meanDecisionSeconds": (
                total_times["decisionSeconds"] / len(executed_trials)
                if executed_trials else None
            ),
            "meanForwardSeconds": (
                total_forward_seconds / total_times["forwardPasses"]
                if total_times["forwardPasses"] else None
            ),
            "inputTokensMinimum": min(input_tokens) if input_tokens else None,
            "inputTokensMaximum": max(input_tokens) if input_tokens else None,
            "inputTokensMean": (
                sum(input_tokens) / len(input_tokens) if input_tokens else None
            ),
            "candidateTokensMinimum": min(candidate_tokens) if candidate_tokens else None,
            "candidateTokensMaximum": max(candidate_tokens) if candidate_tokens else None,
            "candidateTokensMean": (
                sum(candidate_tokens) / len(candidate_tokens)
                if candidate_tokens else None
            ),
            "boundaryCrossingTokens": sum(boundary_crossing_tokens),
            "promptsWithBoundaryCrossingTokens": sum(
                count > 0 for count in boundary_crossing_tokens
            ),
            "peakAllocatedBytes": (
                torch.cuda.max_memory_allocated() if args.device == "cuda" else None
            ),
            "peakReservedBytes": (
                torch.cuda.max_memory_reserved() if args.device == "cuda" else None
            ),
        },
        "developmentAtZeroCounterfactualMargin": zero_threshold,
        "calibration": calibration,
        "validation": validation,
        "primaryVerdict": {
            "confirmed": bool(validation.get("confirmed")),
            "rule": (
                "at least four held-out interruptions, every one necessary and aimed at a "
                "relevant fold"
            ),
            "recallCanPromote": False,
            "latencyCanPromote": False,
        },
        "limitations": [
            "Synthetic snapshots represent event boundaries; no Pi event hook is registered.",
            "The fixture supplies one-level expansion projections rather than reading a live fold store.",
            "A repeated neutral token is a geometry control, not a natural-language empty fold.",
            "A token overlapping candidate content and delimiter whitespace is erased as one indivisible token and counted.",
            "A parent and descendant can overlap as actions because every standing fold is measured.",
            "Four offers prevent a singleton pass but cannot establish production precision.",
            "Actual and erased prompts are executed separately and are not latency optimized.",
            "No carrier, context mutation, active-context fold nomination, or runtime interruption is exercised.",
        ],
        "splits": {
            "development": {"trials": development_trials},
            "validation": {"trials": validation_trials},
        },
    }
    return {**stable, "evidenceSha256": attention.stable_sha256(stable)}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Subtract an equal-token candidate-erased expand-versus-skip margin from every "
            "complete per-fold judgment. The default dry run makes no model or network calls."
        )
    )
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default=attention.DEFAULT_MODEL)
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        print(json.dumps(self_test(), indent=2))
        return 0
    fixture_path = Path(args.fixture).expanduser().resolve()
    refuse(
        fixture_path.is_file(),
        f"attention-counterfactual-fixture-missing:{fixture_path}",
    )
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path)
    else:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "contract": {**fixture_contract(fixture), "model": args.model},
            "fixtureSha256": attention.sha256_file(fixture_path),
            "selfTest": self_test(),
        }
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        output = attention.safe_output_path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
        print(json.dumps({
            "output": str(output),
            "evidenceSha256": report.get("evidenceSha256"),
            "calibration": report.get("calibration", {}).get("selected"),
            "validation": report.get("validation"),
            "primaryVerdict": report.get("primaryVerdict"),
            "runtime": report.get("runtime"),
        }, indent=2))
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, RuntimeError) as error:
        sys.stderr.write(f"Attention per-fold counterfactual probe failed: {error}\n")
        raise SystemExit(1)
