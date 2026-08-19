#!/usr/bin/env python3
"""Precision-first per-fold answerability transition probe."""

from __future__ import annotations

import argparse
import json
import math
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
SCORER_ID = "qwen3-per-fold-answerability-transition-v1"
POLICY_ID = "positive-zero-false-answerability-transition-event-v1"
CONFIDENCE_SCALAR = (
    "maximum per-fold minimum of expanded sufficiency margin and negated "
    "active-only sufficiency margin"
)
SUFFICIENT_CHOICE = " sufficient"
INSUFFICIENT_CHOICE = " insufficient"
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
MINIMUM_TRANSITION_THRESHOLD = 0.0
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
            "the largest strictly positive answerability-transition bottleneck meets or "
            "exceeds the frozen threshold"
        ),
        "candidateAction": (
            "expand exactly the fold with the largest answerability-transition bottleneck"
        ),
        "forwardsPerDecision": (
            "two independent local-model forwards per supplied fold, expanded then equal-token "
            "active-only control; the count varies with the complete standing fold set"
        ),
        "ranker": None,
        "choiceTokens": [SUFFICIENT_CHOICE, INSUFFICIENT_CHOICE],
        "judgment": (
            "whether the supplied active context and candidate evidence contain enough stated "
            "evidence to answer the current task correctly and completely"
        ),
        "transition": {
            "expanded": (
                "sufficient logit minus insufficient logit with the complete fold present"
            ),
            "activeOnlyControl": (
                "the same sufficiency margin after every token overlapping fold content is "
                "replaced by one ordinary neutral token id"
            ),
            "equalGeometry": (
                "input length, attention mask, and every token outside candidate content are "
                "identical across the pair"
            ),
            "answerabilityGain": (
                "expanded sufficiency margin minus active-only sufficiency margin"
            ),
            "score": (
                "minimum of expanded sufficiency margin and negated active-only sufficiency "
                "margin"
            ),
            "meaning": (
                "a positive score requires the complete fold to make the task sufficient while "
                "the equal-token active-only control remains insufficient"
            ),
            "minimumThreshold": MINIMUM_TRANSITION_THRESHOLD,
            "thresholdIsStrictlyPositive": True,
        },
        "jointCorrectOffer": (
            "the winning fold has a strictly positive answerability transition, is necessary "
            "now, and is relevant to the current task"
        ),
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "minimumThreshold": MINIMUM_TRANSITION_THRESHOLD,
            "thresholdIsStrictlyPositive": True,
            "selection": (
                "lowest positive transition threshold with zero false offers and the most offers"
            ),
        },
        "boundary": (
            "offline selector experiment only; no carrier, Pi event registration, context "
            "mutation, threshold promotion, active-context nomination, quantization, batching, "
            "model swap, or latency optimization"
        ),
    }


def choice_token_ids(tokenizer: Any) -> dict[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    result = {}
    for name, text in (
        ("sufficient", SUFFICIENT_CHOICE),
        ("insufficient", INSUFFICIENT_CHOICE),
    ):
        ids = tokenizer.encode(text, add_special_tokens=False)
        refuse(
            len(ids) == 1 and ids[0] not in special_ids,
            f"attention-answerability-choice-must-be-one-ordinary-token:{name}:{ids}",
        )
        result[name] = int(ids[0])
    refuse(
        result["sufficient"] != result["insufficient"],
        "attention-answerability-choice-token-collision",
    )
    return result


def build_prompt_text(
    tokenizer: Any,
    fold: dict[str, Any],
    case: dict[str, Any],
) -> dict[str, Any]:
    system = (
        "Act as a strict evidence-sufficiency judge. Decide only whether the provided context "
        "contains enough stated evidence to answer the current task correctly and completely. "
        "Choose sufficient only when every requested fact or operation is directly supported "
        "by the provided context. Choose insufficient when required evidence is missing, merely "
        "topically related, or would need to be inferred. Do not judge whether evidence is "
        "interesting or whether exposing more context might generally help. False sufficient "
        "judgments are worse than missed sufficient judgments. Reply with exactly sufficient "
        "or insufficient."
    )
    parent = fold["parentFoldId"] if fold["parentFoldId"] is not None else "root"
    prefix = (
        f'<EVENT kind="{case["eventKind"]}">\n'
        "This snapshot was taken immediately after this event boundary.\n"
        "</EVENT>\n\n<ACTIVE_CONTEXT>\n"
        f'{case["activeContext"]}\n'
        "</ACTIVE_CONTEXT>\n\n<CURRENT_TASK>\n"
        f'{case["task"]}\n'
        "</CURRENT_TASK>\n\n<CANDIDATE_EVIDENCE "
        f'id="{fold["foldId"]}" parent="{parent}" depth="{fold["depth"]}">\n'
    )
    suffix = (
        "\n</CANDIDATE_EVIDENCE>\n\n"
        "Using all provided context above, is there enough stated evidence to answer the "
        "current task correctly and completely?"
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
    refuse(user_start >= 0, "attention-answerability-chat-template-lost-user-content")
    refuse(
        rendered.find(user, user_start + 1) < 0,
        "attention-answerability-chat-template-duplicated-user-content",
    )
    content_start = user_start + len(prefix)
    content_end = content_start + len(content)
    refuse(
        rendered[content_start:content_end] == content,
        "attention-answerability-candidate-span-mismatch",
    )
    return {
        "fullPrompt": rendered + "Judgment:",
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
        f"attention-answerability-empty-candidate-token-span:{fold['foldId']}",
    )
    refuse(
        offsets[candidate_tokens[0]][0] <= built["candidateStart"]
        and offsets[candidate_tokens[-1]][1] >= built["candidateEnd"]
        and all(
            offsets[left][1] == offsets[right][0]
            for left, right in zip(candidate_tokens, candidate_tokens[1:])
        ),
        f"attention-answerability-candidate-token-coverage-gap:{fold['foldId']}",
    )
    boundary_crossing_tokens = sum(
        offsets[position][0] < built["candidateStart"]
        or offsets[position][1] > built["candidateEnd"]
        for position in candidate_tokens
    )
    active_only_encoded = {key: value.clone() for key, value in encoded.items()}
    active_only_encoded["input_ids"][0, candidate_tokens] = neutral_token_id
    refuse(
        active_only_encoded["input_ids"].shape == encoded["input_ids"].shape
        and active_only_encoded["attention_mask"].tolist()
        == encoded["attention_mask"].tolist(),
        "attention-answerability-control-geometry-drift",
    )
    refuse(
        all(
            int(active_only_encoded["input_ids"][0, position]) == neutral_token_id
            for position in candidate_tokens
        ),
        "attention-answerability-candidate-erasure-incomplete",
    )
    candidate_token_set = set(candidate_tokens)
    refuse(
        all(
            int(active_only_encoded["input_ids"][0, position])
            == int(encoded["input_ids"][0, position])
            for position in range(encoded["input_ids"].shape[1])
            if position not in candidate_token_set
        ),
        "attention-answerability-noncandidate-token-changed",
    )
    return {
        "expandedEncoded": encoded,
        "activeOnlyEncoded": active_only_encoded,
        "promptSha256": attention.sha256_text(full_prompt),
        "expandedInputSha256": attention.sha256_text(
            json.dumps(encoded["input_ids"][0].tolist(), separators=(",", ":"))
        ),
        "activeOnlyInputSha256": attention.sha256_text(
            json.dumps(
                active_only_encoded["input_ids"][0].tolist(),
                separators=(",", ":"),
            )
        ),
        "inputTokens": int(encoded["input_ids"].shape[1]),
        "candidateTokens": len(candidate_tokens),
        "boundaryCrossingTokens": boundary_crossing_tokens,
        "candidateChars": len(fold["expandedContent"]),
        "candidateContentSha256": attention.sha256_text(fold["expandedContent"]),
    }


def sufficiency_values(
    sufficient_logit: float,
    insufficient_logit: float,
) -> dict[str, float | str]:
    margin = sufficient_logit - insufficient_logit
    if margin >= 0:
        probability = 1.0 / (1.0 + math.exp(-margin))
    else:
        exp_margin = math.exp(margin)
        probability = exp_margin / (1.0 + exp_margin)
    return {
        "sufficientLogit": sufficient_logit,
        "insufficientLogit": insufficient_logit,
        "sufficiencyMargin": margin,
        "sufficientProbabilityWithinChoices": probability,
        "unthresholdedChoice": "sufficient" if margin >= 0 else "insufficient",
    }


def transition_values(
    expanded: dict[str, float | str],
    active_only: dict[str, float | str],
) -> dict[str, Any]:
    expanded_margin = float(expanded["sufficiencyMargin"])
    active_only_margin = float(active_only["sufficiencyMargin"])
    return {
        "expanded": expanded,
        "activeOnlyControl": active_only,
        "expandedSufficiencyMargin": expanded_margin,
        "activeOnlySufficiencyMargin": active_only_margin,
        "answerabilityGain": expanded_margin - active_only_margin,
        "transitionMargin": min(expanded_margin, -active_only_margin),
    }


def score_once(
    torch: Any,
    model: Any,
    encoded: dict[str, Any],
    device: str,
    token_ids: dict[str, int],
) -> tuple[dict[str, float | str], float]:
    device_encoded = {key: value.to(device) for key, value in encoded.items()}
    if device == "cuda":
        torch.cuda.synchronize()
    started = time.perf_counter()
    with torch.inference_mode():
        outputs = model(
            **device_encoded,
            use_cache=False,
            output_attentions=False,
            return_dict=True,
        )
    if device == "cuda":
        torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    logits = outputs.logits[0, -1].float()
    values = sufficiency_values(
        float(logits[token_ids["sufficient"]].item()),
        float(logits[token_ids["insufficient"]].item()),
    )
    del logits, outputs, device_encoded
    return values, elapsed


def ranked_folds(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(rows, key=lambda row: (-row["transitionMargin"], row["id"]))
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
                f"attention-answerability-input-exceeds-model-context:{split_name}:"
                f"{case['id']}:{fold_id}:{prompt['inputTokens']}:{context_tokens}",
            )
            prompts.append({"foldId": fold_id, "prompt": prompt})
        refuse(
            len(prompts) == len(fold_ids)
            and {row["foldId"] for row in prompts} == set(fold_ids),
            f"attention-answerability-did-not-measure-every-fold:"
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
        "expandedForwardSeconds": 0.0,
        "activeOnlyForwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    for index, item in enumerate(prepared, start=1):
        decision_started = time.perf_counter()
        case = item["case"]
        folds = []
        for prompt_row in item["prompts"]:
            prompt = prompt_row["prompt"]
            expanded, expanded_seconds = score_once(
                torch,
                model,
                prompt["expandedEncoded"],
                device,
                token_ids,
            )
            active_only, active_only_seconds = score_once(
                torch,
                model,
                prompt["activeOnlyEncoded"],
                device,
                token_ids,
            )
            totals["expandedForwardSeconds"] += expanded_seconds
            totals["activeOnlyForwardSeconds"] += active_only_seconds
            totals["forwardPasses"] += 2
            folds.append({
                "id": prompt_row["foldId"],
                "promptSha256": prompt["promptSha256"],
                "expandedInputSha256": prompt["expandedInputSha256"],
                "activeOnlyInputSha256": prompt["activeOnlyInputSha256"],
                "inputTokens": prompt["inputTokens"],
                "candidateTokens": prompt["candidateTokens"],
                "boundaryCrossingTokens": prompt["boundaryCrossingTokens"],
                "candidateChars": prompt["candidateChars"],
                "candidateContentSha256": prompt["candidateContentSha256"],
                "expandedForwardSeconds": expanded_seconds,
                "activeOnlyForwardSeconds": active_only_seconds,
                **transition_values(expanded, active_only),
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
            "winnerTransitionMargin": winner["transitionMargin"],
            "decisionSeconds": decision_seconds,
            "folds": ranked,
        })
        if index % 4 == 0 or index == len(prepared):
            print(
                f"attention answerability {split_name}: {index}/{len(prepared)} events",
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
        "confidence": winner["transitionMargin"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [
        point for point in sweep
        if point["threshold"] > MINIMUM_TRANSITION_THRESHOLD
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
        "minimumThreshold": MINIMUM_TRANSITION_THRESHOLD,
        "thresholdIsStrictlyPositive": True,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def self_test() -> dict[str, Any]:
    transition = transition_values(
        sufficiency_values(3.0, 1.0),
        sufficiency_values(1.0, 2.0),
    )
    redundant = transition_values(
        sufficiency_values(3.0, 1.0),
        sufficiency_values(2.0, 1.0),
    )
    missing_candidate = transition_values(
        sufficiency_values(1.0, 2.0),
        sufficiency_values(0.0, 2.0),
    )
    refuse(
        transition["expandedSufficiencyMargin"] == 2.0
        and transition["activeOnlySufficiencyMargin"] == -1.0
        and transition["answerabilityGain"] == 3.0
        and transition["transitionMargin"] == 1.0,
        "attention-answerability-transition-self-test-failed",
    )
    refuse(
        redundant["transitionMargin"] == -1.0
        and missing_candidate["transitionMargin"] == -1.0,
        "attention-answerability-bottleneck-self-test-failed",
    )
    ranked = ranked_folds([
        {"id": "z-fold", "transitionMargin": 0.8},
        {"id": "a-fold", "transitionMargin": 0.8},
        {"id": "low-fold", "transitionMargin": -0.4},
    ])
    refuse(
        [row["id"] for row in ranked] == ["a-fold", "z-fold", "low-fold"],
        "attention-answerability-deterministic-ranking-self-test-failed",
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
        "attention-answerability-calibration-self-test-failed",
    )
    zero_only = [{**row, "confidence": 0.0} for row in decisions[:4]]
    refuse(
        calibrate_threshold(zero_only)["selected"] is None,
        "attention-answerability-zero-threshold-self-test-failed",
    )
    wrong_fold_trial = {
        "caseId": "wrong-fold",
        "class": "positive",
        "eventKind": "stop",
        "relevantFoldIds": ["right"],
        "folds": [
            {"id": "wrong", "transitionMargin": 4.0, "rank": 1},
            {"id": "right", "transitionMargin": 3.0, "rank": 2},
        ],
    }
    refuse(
        decision_row(wrong_fold_trial)["correct"] is False,
        "attention-answerability-wrong-fold-self-test-failed",
    )
    return {
        "expandedSufficiencyMargin": transition["expandedSufficiencyMargin"],
        "activeOnlySufficiencyMargin": transition["activeOnlySufficiencyMargin"],
        "answerabilityGain": transition["answerabilityGain"],
        "transitionMargin": transition["transitionMargin"],
        "redundantTransitionMargin": redundant["transitionMargin"],
        "missingCandidateTransitionMargin": missing_candidate["transitionMargin"],
        "rankedFoldIds": [row["id"] for row in ranked],
        "threshold": selected["threshold"],
        "offers": selected["offers"],
        "falseOffers": selected["falseOffers"],
        "zeroThresholdRefused": True,
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
        "attention-answerability-device-must-be-cuda-or-cpu",
    )
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-answerability-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-answerability-needs-fast-tokenizer-offsets",
    )
    token_ids = choice_token_ids(tokenizer)
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
        MINIMUM_TRANSITION_THRESHOLD,
    )
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "expandedForwardSeconds": 0.0,
        "activeOnlyForwardSeconds": 0.0,
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
        total_times["expandedForwardSeconds"]
        + total_times["activeOnlyForwardSeconds"]
    )
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "per-fold active-context answerability transition",
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
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
            "sufficientTokenText": SUFFICIENT_CHOICE,
            "sufficientTokenId": token_ids["sufficient"],
            "insufficientTokenText": INSUFFICIENT_CHOICE,
            "insufficientTokenId": token_ids["insufficient"],
            "neutralTokenText": neutral_text,
            "neutralTokenId": neutral_token_id,
            "confidenceScalar": CONFIDENCE_SCALAR,
            "allFoldNodesMeasured": True,
            "separateSufficiencyPromptPerFold": True,
            "equalTokenCandidateErasure": True,
            "strictPositiveTransition": True,
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
        "developmentAtZeroTransition": zero_threshold,
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
            "A repeated neutral token is a geometry control, not natural-language active context alone.",
            "A token overlapping candidate content and delimiter whitespace is erased as one indivisible token and counted.",
            "A parent and descendant can overlap as actions because every standing fold is measured.",
            "Four offers prevent a singleton pass but cannot establish production precision.",
            "Expanded and active-only controls are executed separately and are not latency optimized.",
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
            "Measure whether each complete fold changes a task from insufficient to sufficient "
            "against an equal-token active-only control. The default dry run makes no model or "
            "network calls."
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
        f"attention-answerability-fixture-missing:{fixture_path}",
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
        sys.stderr.write(f"Attention answerability transition probe failed: {error}\n")
        raise SystemExit(1)
