#!/usr/bin/env python3
"""Precision-first conditional utility for each complete folded expansion."""

from __future__ import annotations

import argparse
import json
import math
import platform
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_selective as selective
import probe_attention_shadow as attention
import probe_attention_utility as utility


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-per-fold-expand-skip-utility-v1"
POLICY_ID = "zero-false-per-fold-expansion-event-v1"
CONFIDENCE_SCALAR = "maximum per-fold expand next-token logit minus skip next-token logit"
EXPAND_CHOICE = " expand"
SKIP_CHOICE = " skip"
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    split_rows = {}
    for split_name, split in fixture["splits"].items():
        cases = utility.expanded_cases(split)
        counts = {
            case_class: sum(case["class"] == case_class for case in cases)
            for case_class in utility.CASE_CLASSES
        }
        events = {
            event_kind: sum(case["eventKind"] == event_kind for case in cases)
            for event_kind in utility.EVENT_KINDS
        }
        hierarchy = utility.hierarchy_summary(split["folds"], split_name)
        split_rows[split_name] = {
            **hierarchy,
            "eventSnapshots": len(cases),
            "classes": counts,
            "positiveRate": counts["positive"] / len(cases),
            "foldRowsPerSnapshot": len(split["folds"]),
            "eventKinds": events,
        }
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "scorerId": SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "interruptWhen": (
            "the largest per-fold expand-minus-skip margin meets or exceeds the frozen threshold"
        ),
        "attemptCadence": "one decision at every supplied eligible event snapshot",
        "eligibleEventKinds": list(utility.EVENT_KINDS),
        "runtimeEventHook": False,
        "candidateUniverse": "standing folded nodes only",
        "candidateAction": "expand exactly the fold with the largest conditional utility margin",
        "candidateContent": "complete supplied one-level expansion projection for that fold",
        "hierarchy": (
            "every root and nested fold is independently scored; ancestry records provenance "
            "and never prunes, flattens, or prefilters descendants"
        ),
        "candidateSelection": "all supplied fold nodes in every decision",
        "inputTruncation": False,
        "prefilter": None,
        "forwardsPerDecision": (
            "one independent local-model forward per supplied fold; the count varies with the "
            "complete standing fold set"
        ),
        "ranker": None,
        "choiceTokens": [EXPAND_CHOICE, SKIP_CHOICE],
        "generationCalls": 0,
        "providerCalls": 0,
        "labelsVisibleToScorer": False,
        "jointCorrectOffer": (
            "the winning fold is necessary now and is relevant to the current task"
        ),
        "everyOtherOffer": (
            "false, including a wrong fold on a positive event or any fold on a negative event"
        ),
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "selection": "lowest conditional-utility threshold with zero false offers and the most offers",
        },
        "validation": (
            "not run unless development selects a threshold; selected threshold frozen"
        ),
        "primaryOutcome": "zero false offers at nonzero anti-vacuous held-out coverage",
        "nonPromotionalDiagnostics": ["recall", "offer rate", "latency", "memory"],
        "splits": split_rows,
        "boundary": (
            "offline selector experiment only; no carrier, Pi event registration, context "
            "mutation, threshold promotion, active-context nomination, quantization, batching, "
            "or latency optimization"
        ),
    }


def choice_token_ids(tokenizer: Any) -> dict[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    result = {}
    for name, text in (("expand", EXPAND_CHOICE), ("skip", SKIP_CHOICE)):
        ids = tokenizer.encode(text, add_special_tokens=False)
        refuse(
            len(ids) == 1 and ids[0] not in special_ids,
            f"attention-per-fold-choice-must-be-one-ordinary-token:{name}:{ids}",
        )
        result[name] = int(ids[0])
    refuse(
        result["expand"] != result["skip"],
        "attention-per-fold-choice-token-collision",
    )
    return result


def prepare_fold_prompt(
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
    user = (
        f'<EVENT kind="{case["eventKind"]}">\n'
        "This snapshot was taken immediately after this event boundary.\n"
        "</EVENT>\n\n<ACTIVE_CONTEXT>\n"
        f'{case["activeContext"]}\n'
        "</ACTIVE_CONTEXT>\n\n<CURRENT_TASK>\n"
        f'{case["task"]}\n'
        "</CURRENT_TASK>\n\n<CANDIDATE_FOLD "
        f'id="{fold["foldId"]}" parent="{parent}" depth="{fold["depth"]}">\n'
        f'{fold["expandedContent"]}\n'
        "</CANDIDATE_FOLD>\n\n"
        "If this fold were expanded into active context now, would it provide necessary missing "
        "evidence that warrants interrupting the agent?"
    )
    rendered = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    full_prompt = rendered + "Decision:"
    encoded = tokenizer(
        full_prompt,
        add_special_tokens=False,
        truncation=False,
        return_tensors="pt",
    )
    return {
        "encoded": encoded,
        "promptSha256": attention.sha256_text(full_prompt),
        "inputTokens": int(encoded["input_ids"].shape[1]),
    }


def utility_values(expand_logit: float, skip_logit: float) -> dict[str, float | str]:
    margin = expand_logit - skip_logit
    if margin >= 0:
        probability = 1.0 / (1.0 + math.exp(-margin))
    else:
        exp_margin = math.exp(margin)
        probability = exp_margin / (1.0 + exp_margin)
    return {
        "expandLogit": expand_logit,
        "skipLogit": skip_logit,
        "utilityMargin": margin,
        "expandProbabilityWithinChoices": probability,
        "unthresholdedChoice": "expand" if margin >= 0 else "skip",
    }


def prepare_split(
    tokenizer: Any,
    split_name: str,
    split: dict[str, Any],
    context_tokens: int,
) -> list[dict[str, Any]]:
    folds_by_id = {fold["foldId"]: fold for fold in split["folds"]}
    fold_ids = list(folds_by_id)
    orders = attention.rotations(fold_ids)
    prepared = []
    for case in utility.expanded_cases(split):
        order = orders[case["rotation"]]
        prompts = []
        for fold_id in order:
            prompt = prepare_fold_prompt(tokenizer, folds_by_id[fold_id], case)
            refuse(
                prompt["inputTokens"] <= context_tokens,
                f"attention-per-fold-input-exceeds-model-context:{split_name}:"
                f"{case['id']}:{fold_id}:{prompt['inputTokens']}:{context_tokens}",
            )
            prompts.append({"foldId": fold_id, "prompt": prompt})
        refuse(
            len(prompts) == len(fold_ids)
            and {row["foldId"] for row in prompts} == set(fold_ids),
            f"attention-per-fold-did-not-measure-every-fold:{split_name}:{case['id']}",
        )
        prepared.append({"case": case, "order": order, "prompts": prompts})
    return prepared


def score_fold_once(
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
    values = utility_values(
        float(logits[token_ids["expand"]].item()),
        float(logits[token_ids["skip"]].item()),
    )
    del logits, outputs, device_encoded
    return values, elapsed


def ranked_folds(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(rows, key=lambda row: (-row["utilityMargin"], row["id"]))
    return [{**row, "rank": rank} for rank, row in enumerate(ranked, start=1)]


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
        "foldForwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    for index, item in enumerate(prepared, start=1):
        decision_started = time.perf_counter()
        case = item["case"]
        folds = []
        for prompt_row in item["prompts"]:
            values, forward_seconds = score_fold_once(
                torch,
                model,
                prompt_row["prompt"]["encoded"],
                device,
                token_ids,
            )
            totals["foldForwardSeconds"] += forward_seconds
            totals["forwardPasses"] += 1
            folds.append({
                "id": prompt_row["foldId"],
                "promptSha256": prompt_row["prompt"]["promptSha256"],
                "inputTokens": prompt_row["prompt"]["inputTokens"],
                "forwardSeconds": forward_seconds,
                **values,
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
            "winnerMargin": winner["utilityMargin"],
            "decisionSeconds": decision_seconds,
            "folds": ranked,
        })
        if index % 5 == 0 or index == len(prepared):
            print(
                f"attention per-fold {split_name}: {index}/{len(prepared)} events",
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
        "confidence": winner["utilityMargin"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [
        point for point in sweep
        if point["offers"] >= MIN_DEVELOPMENT_OFFERS
        and point["precision"] == DEVELOPMENT_REQUIRED_PRECISION
    ]
    selected = max(
        eligible,
        key=lambda point: (point["offers"], -point["threshold"]),
    ) if eligible else None
    return {
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def self_test() -> dict[str, Any]:
    values = utility_values(3.0, 1.0)
    refuse(
        values["utilityMargin"] == 2.0
        and values["unthresholdedChoice"] == "expand"
        and 0.88 < values["expandProbabilityWithinChoices"] < 0.89,
        "attention-per-fold-logit-margin-self-test-failed",
    )
    ranked = ranked_folds([
        {"id": "z-fold", "utilityMargin": 0.8},
        {"id": "a-fold", "utilityMargin": 0.8},
        {"id": "low-fold", "utilityMargin": -0.4},
    ])
    refuse(
        [row["id"] for row in ranked] == ["a-fold", "z-fold", "low-fold"],
        "attention-per-fold-deterministic-ranking-self-test-failed",
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
        "attention-per-fold-calibration-self-test-failed",
    )
    refuse(
        calibrate_threshold(decisions[1:])["selected"] is None,
        "attention-per-fold-minimum-offers-self-test-failed",
    )
    wrong_fold_trial = {
        "caseId": "wrong-fold",
        "class": "positive",
        "eventKind": "stop",
        "relevantFoldIds": ["right"],
        "folds": [
            {"id": "wrong", "utilityMargin": 4.0, "rank": 1},
            {"id": "right", "utilityMargin": 3.0, "rank": 2},
        ],
    }
    refuse(
        decision_row(wrong_fold_trial)["correct"] is False,
        "attention-per-fold-wrong-fold-self-test-failed",
    )
    return {
        "utilityMargin": values["utilityMargin"],
        "unthresholdedChoice": values["unthresholdedChoice"],
        "rankedFoldIds": [row["id"] for row in ranked],
        "threshold": selected["threshold"],
        "offers": selected["offers"],
        "falseOffers": selected["falseOffers"],
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
        "attention-per-fold-device-must-be-cuda-or-cpu",
    )
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-per-fold-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    token_ids = choice_token_ids(tokenizer)
    development_prepared = prepare_split(
        tokenizer,
        "development",
        fixture["splits"]["development"],
        config.max_position_embeddings,
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
    zero_threshold = selective.decision_metrics(development_decisions, 0.0)
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "foldForwardSeconds": 0.0,
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
    input_tokens = [
        fold["inputTokens"]
        for trial in executed_trials
        for fold in trial["folds"]
    ]
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "precision-first conditional utility for each hierarchical fold expansion",
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
            "expandTokenText": EXPAND_CHOICE,
            "expandTokenId": token_ids["expand"],
            "skipTokenText": SKIP_CHOICE,
            "skipTokenId": token_ids["skip"],
            "confidenceScalar": CONFIDENCE_SCALAR,
            "allFoldNodesMeasured": True,
            "separateConditionalPromptPerFold": True,
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
                total_times["foldForwardSeconds"] / total_times["forwardPasses"]
                if total_times["forwardPasses"] else None
            ),
            "inputTokensMinimum": min(input_tokens) if input_tokens else None,
            "inputTokensMaximum": max(input_tokens) if input_tokens else None,
            "inputTokensMean": (
                sum(input_tokens) / len(input_tokens) if input_tokens else None
            ),
            "peakAllocatedBytes": (
                torch.cuda.max_memory_allocated() if args.device == "cuda" else None
            ),
            "peakReservedBytes": (
                torch.cuda.max_memory_reserved() if args.device == "cuda" else None
            ),
        },
        "developmentAtZeroMargin": zero_threshold,
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
            "A parent and descendant can overlap as actions because every standing fold is measured.",
            "Four offers prevent a singleton pass but cannot establish production precision.",
            "Prompts are executed separately and are not yet batched or latency optimized.",
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
            "Test a separate constrained expand-versus-skip utility margin for every complete "
            "fold after synthetic event snapshots. The default dry run makes no model or "
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
        f"attention-per-fold-fixture-missing:{fixture_path}",
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
        sys.stderr.write(f"Attention per-fold utility probe failed: {error}\n")
        raise SystemExit(1)
