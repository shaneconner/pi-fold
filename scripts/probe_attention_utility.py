#!/usr/bin/env python3
"""Precision-first event utility over complete hierarchical fold expansions."""

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
import probe_attention_selective as selective
import probe_attention_shadow as attention


PROTOCOL_VERSION = 1
FIXTURE_ID = "fold-expansion-event-utility-v1"
RANKER_ID = contrastive.SCORER_ID
UTILITY_SCORER_ID = "qwen3-retrieve-skip-next-token-utility-v1"
POLICY_ID = "zero-false-fold-expansion-event-v1"
CONFIDENCE_SCALAR = "retrieve next-token logit minus skip next-token logit"
RETRIEVE_CHOICE = " retrieve"
SKIP_CHOICE = " skip"
EVENT_KINDS = ("user-message", "tool-result", "assistant-message", "stop")
CASE_CLASSES = (
    "positive",
    "no-relevant",
    "already-visible",
    "semantically-related-but-non-answering",
    "interruption-not-worthwhile",
)
NEGATIVE_CLASSES = CASE_CLASSES[1:]
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = PROJECT / "scripts" / "fixtures" / "attention_utility_v1.json"


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def hierarchy_summary(folds: list[dict[str, Any]], split_name: str) -> dict[str, Any]:
    by_id = {fold["foldId"]: fold for fold in folds}
    depths: dict[str, int] = {}

    def depth_for(fold_id: str, visiting: frozenset[str]) -> int:
        if fold_id in depths:
            return depths[fold_id]
        refuse(fold_id not in visiting,
               f"attention-utility-fold-hierarchy-cycle:{split_name}:{fold_id}")
        parent_id = by_id[fold_id]["parentFoldId"]
        if parent_id is None:
            depth = 0
        else:
            refuse(parent_id in by_id,
                   f"attention-utility-missing-parent:{split_name}:{fold_id}:{parent_id}")
            depth = 1 + depth_for(parent_id, visiting | {fold_id})
        depths[fold_id] = depth
        return depth

    for fold in folds:
        derived = depth_for(fold["foldId"], frozenset())
        refuse(fold["depth"] == derived,
               f"attention-utility-depth-mismatch:{split_name}:{fold['foldId']}:"
               f"{fold['depth']}:{derived}")
    root_ids = sorted(fold_id for fold_id, fold in by_id.items()
                      if fold["parentFoldId"] is None)
    nested_ids = sorted(fold_id for fold_id, fold in by_id.items()
                        if fold["parentFoldId"] is not None)
    maximum_depth = max(depths.values(), default=0)
    refuse(bool(root_ids) and bool(nested_ids) and maximum_depth >= 2,
           f"attention-utility-fixture-needs-multilevel-folds:{split_name}")
    return {
        "folds": len(folds),
        "roots": len(root_ids),
        "nested": len(nested_ids),
        "maximumDepth": maximum_depth,
        "rootFoldIds": root_ids,
        "nestedFoldIds": nested_ids,
        "allFoldIds": sorted(by_id),
    }


def load_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    refuse(fixture.get("protocolVersion") == PROTOCOL_VERSION,
           "attention-utility-fixture-version-mismatch")
    refuse(fixture.get("fixtureId") == FIXTURE_ID,
           "attention-utility-fixture-id-mismatch")
    splits = fixture.get("splits")
    refuse(isinstance(splits, dict) and set(splits) == {"development", "validation"},
           "attention-utility-needs-development-and-validation")
    split_ids: dict[str, set[str]] = {}
    for split_name, split in splits.items():
        refuse(isinstance(split, dict) and set(split) == {"folds"},
               f"attention-utility-split-shape-mismatch:{split_name}")
        folds = split["folds"]
        refuse(isinstance(folds, list) and len(folds) >= 2,
               f"attention-utility-needs-folds:{split_name}")
        fold_ids = [fold.get("foldId") for fold in folds if isinstance(fold, dict)]
        refuse(len(fold_ids) == len(folds) and
               all(isinstance(fold_id, str) and fold_id for fold_id in fold_ids),
               f"attention-utility-fold-needs-id:{split_name}")
        refuse(len(set(fold_ids)) == len(fold_ids),
               f"attention-utility-fold-ids-must-be-unique:{split_name}")
        split_ids[split_name] = set(fold_ids)
        for fold in folds:
            refuse(set(fold) == {
                "foldId", "parentFoldId", "depth", "expandedContent", "cases"
            }, f"attention-utility-fold-shape-mismatch:{split_name}:{fold.get('foldId')}")
            refuse(fold["parentFoldId"] is None or
                   isinstance(fold["parentFoldId"], str),
                   f"attention-utility-parent-id-invalid:{split_name}:{fold['foldId']}")
            refuse(type(fold["depth"]) is int and fold["depth"] >= 0,
                   f"attention-utility-depth-invalid:{split_name}:{fold['foldId']}")
            refuse(isinstance(fold["expandedContent"], str) and
                   fold["expandedContent"].strip(),
                   f"attention-utility-fold-needs-expanded-content:"
                   f"{split_name}:{fold['foldId']}")
            cases = fold["cases"]
            refuse(isinstance(cases, dict) and set(cases) == set(CASE_CLASSES),
                   f"attention-utility-case-set-mismatch:{split_name}:{fold['foldId']}")
            for case_class in CASE_CLASSES:
                case = cases[case_class]
                refuse(isinstance(case, dict) and set(case) == {"activeContext", "task"},
                       f"attention-utility-case-shape-mismatch:"
                       f"{split_name}:{fold['foldId']}:{case_class}")
                refuse(all(isinstance(case[field], str) and case[field].strip()
                           for field in ("activeContext", "task")),
                       f"attention-utility-case-needs-text:"
                       f"{split_name}:{fold['foldId']}:{case_class}")
            refuse(cases["positive"]["task"] == cases["already-visible"]["task"],
                   f"attention-utility-visible-task-drift:{split_name}:{fold['foldId']}")
            refuse(cases["positive"]["activeContext"] !=
                   cases["already-visible"]["activeContext"],
                   f"attention-utility-visible-context-not-varied:"
                   f"{split_name}:{fold['foldId']}")
        hierarchy_summary(folds, split_name)
    refuse(split_ids["development"].isdisjoint(split_ids["validation"]),
           "attention-utility-split-fold-overlap")
    return fixture


def expanded_cases(split: dict[str, Any]) -> list[dict[str, Any]]:
    folds = split["folds"]
    count = len(folds)
    rows = []
    for fold_index, fold in enumerate(folds):
        for class_index, case_class in enumerate(CASE_CLASSES):
            case = fold["cases"][case_class]
            event_kind = EVENT_KINDS[(fold_index + class_index) % len(EVENT_KINDS)]
            rows.append({
                "id": f"{case_class}-{fold['foldId']}",
                "class": case_class,
                "eventKind": event_kind,
                "activeContext": case["activeContext"],
                "task": case["task"],
                "rotation": (2 * fold_index + class_index) % count,
                "themeFoldId": fold["foldId"],
                "relevantFoldIds": [fold["foldId"]] if case_class == "positive" else [],
            })
    return rows


def ranker_query(case: dict[str, Any]) -> str:
    return (
        f"Event boundary: {case['eventKind']}\n"
        f"Active context after the event:\n{case['activeContext']}\n\n"
        f"Current task:\n{case['task']}"
    )


def ranker_candidates(split: dict[str, Any]) -> dict[str, dict[str, str]]:
    return {
        fold["foldId"]: {
            "id": fold["foldId"],
            "content": fold["expandedContent"],
        }
        for fold in split["folds"]
    }


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    split_rows = {}
    for split_name, split in fixture["splits"].items():
        cases = expanded_cases(split)
        counts = {case_class: sum(case["class"] == case_class for case in cases)
                  for case_class in CASE_CLASSES}
        events = {event_kind: sum(case["eventKind"] == event_kind for case in cases)
                  for event_kind in EVENT_KINDS}
        hierarchy = hierarchy_summary(split["folds"], split_name)
        split_rows[split_name] = {
            **hierarchy,
            "eventSnapshots": len(cases),
            "classes": counts,
            "positiveRate": counts["positive"] / len(cases),
            "eventKinds": events,
            "foldRowsPerSnapshot": len(split["folds"]),
        }
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "rankerId": RANKER_ID,
        "utilityScorerId": UTILITY_SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "interruptWhen": "utility margin meets or exceeds the frozen threshold",
        "attemptCadence": "one decision at every supplied eligible event snapshot",
        "eligibleEventKinds": list(EVENT_KINDS),
        "runtimeEventHook": False,
        "candidateUniverse": "standing folded nodes only",
        "candidateAction": "expand exactly one fold id",
        "candidateContent": "complete supplied one-level expansion projection for that fold",
        "hierarchy": (
            "every root and nested fold is an independent candidate; ancestry records provenance "
            "and never prunes, flattens, or prefilters descendants"
        ),
        "candidateSelection": "all supplied fold nodes in every decision",
        "inputTruncation": False,
        "prefilter": None,
        "forwardsPerDecision": {
            "queryErasureRanker": 2,
            "retrieveSkipUtility": 1,
            "total": 3,
        },
        "choiceTokens": [RETRIEVE_CHOICE, SKIP_CHOICE],
        "generationCalls": 0,
        "providerCalls": 0,
        "labelsVisibleToScorers": False,
        "jointCorrectOffer": (
            "expansion is necessary now and the query-erasure winner is a relevant fold"
        ),
        "everyOtherOffer": (
            "false, including a wrong fold on a positive event or any fold on a negative event"
        ),
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "selection": "lowest utility threshold with zero false offers and the most offers",
        },
        "validation": (
            "not run unless development selects a threshold; selected threshold frozen"
        ),
        "primaryOutcome": "zero false offers at nonzero anti-vacuous held-out coverage",
        "nonPromotionalDiagnostics": ["recall", "offer rate", "latency", "memory"],
        "splits": split_rows,
        "boundary": (
            "offline selector experiment only; no carrier, Pi event registration, context "
            "mutation, threshold promotion, active-context nomination, quantization, or "
            "latency optimization"
        ),
    }


def choice_token_ids(tokenizer: Any) -> dict[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    result = {}
    for name, text in (("retrieve", RETRIEVE_CHOICE), ("skip", SKIP_CHOICE)):
        ids = tokenizer.encode(text, add_special_tokens=False)
        refuse(len(ids) == 1 and ids[0] not in special_ids,
               f"attention-utility-choice-must-be-one-ordinary-token:{name}:{ids}")
        result[name] = int(ids[0])
    refuse(result["retrieve"] != result["skip"],
           "attention-utility-choice-token-collision")
    return result


def prepare_utility_prompt(tokenizer: Any, folds_by_id: dict[str, dict[str, Any]],
                           order: list[str], case: dict[str, Any]) -> dict[str, Any]:
    system = (
        "Decide whether the agent must interrupt its current work to expand one folded context "
        "span. Choose retrieve only when the active context is insufficient for the current "
        "task and at least one listed fold expansion contains the missing evidence. Choose skip "
        "when active context already suffices, when no fold answers the task, or when expanding "
        "a fold would not advance the current task. Candidate order and hierarchy do not imply "
        "importance. Reply with exactly retrieve or skip."
    )
    parts = [
        f'<EVENT kind="{case["eventKind"]}">\n',
        "This decision snapshot was taken immediately after this event boundary.\n",
        "</EVENT>\n\n<ACTIVE_CONTEXT>\n",
        case["activeContext"],
        "\n</ACTIVE_CONTEXT>\n\n<CURRENT_TASK>\n",
        case["task"],
        "\n</CURRENT_TASK>\n\n<FOLDED_CONTEXT>\n",
    ]
    for fold_id in order:
        fold = folds_by_id[fold_id]
        parent = fold["parentFoldId"] if fold["parentFoldId"] is not None else "root"
        parts.extend([
            f'<FOLD id="{fold_id}" parent="{parent}" depth="{fold["depth"]}">\n',
            fold["expandedContent"],
            "\n</FOLD>\n",
        ])
    parts.append(
        "</FOLDED_CONTEXT>\n\nShould the agent interrupt now to expand one listed fold?"
    )
    user = "".join(parts)
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


def utility_values(retrieve_logit: float, skip_logit: float) -> dict[str, float | str]:
    margin = retrieve_logit - skip_logit
    if margin >= 0:
        probability = 1.0 / (1.0 + math.exp(-margin))
    else:
        exp_margin = math.exp(margin)
        probability = exp_margin / (1.0 + exp_margin)
    return {
        "retrieveLogit": retrieve_logit,
        "skipLogit": skip_logit,
        "utilityMargin": margin,
        "retrieveProbabilityWithinChoices": probability,
        "unthresholdedChoice": "retrieve" if margin >= 0 else "skip",
    }


def prepare_split(tokenizer: Any, split_name: str, split: dict[str, Any],
                  context_tokens: int, neutral_token_id: int) -> list[dict[str, Any]]:
    folds_by_id = {fold["foldId"]: fold for fold in split["folds"]}
    candidates_by_id = ranker_candidates(split)
    fold_ids = list(folds_by_id)
    orders = attention.rotations(fold_ids)
    prepared = []
    for case in expanded_cases(split):
        order = orders[case["rotation"]]
        query = ranker_query(case)
        rank_prompt = contrastive.prepare_paired_prompt(
            tokenizer, candidates_by_id, order, query, neutral_token_id)
        utility_prompt = prepare_utility_prompt(tokenizer, folds_by_id, order, case)
        refuse(rank_prompt["inputTokens"] <= context_tokens,
               f"attention-utility-ranker-input-exceeds-model-context:{split_name}:"
               f"{case['id']}:{rank_prompt['inputTokens']}:{context_tokens}")
        refuse(utility_prompt["inputTokens"] <= context_tokens,
               f"attention-utility-decision-input-exceeds-model-context:{split_name}:"
               f"{case['id']}:{utility_prompt['inputTokens']}:{context_tokens}")
        refuse(set(rank_prompt["candidateTokens"]) == set(fold_ids),
               f"attention-utility-ranker-omitted-fold:{split_name}:{case['id']}")
        prepared.append({
            "case": case,
            "order": order,
            "rankPrompt": rank_prompt,
            "utilityPrompt": utility_prompt,
        })
    return prepared


def score_utility_once(torch: Any, model: Any, encoded: dict[str, Any], device: str,
                       token_ids: dict[str, int]) -> tuple[dict[str, float | str], float]:
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
        float(logits[token_ids["retrieve"]].item()),
        float(logits[token_ids["skip"]].item()),
    )
    del logits, outputs, device_encoded
    return values, elapsed


def run_prepared_split(torch: Any, model: Any, device: str, split_name: str,
                       prepared: list[dict[str, Any]], token_ids: dict[str, int]
                       ) -> tuple[list[dict[str, Any]], dict[str, float]]:
    trials = []
    totals = {
        "rankerActualForwardSeconds": 0.0,
        "rankerNeutralForwardSeconds": 0.0,
        "rankerScoreAggregationSeconds": 0.0,
        "utilityForwardSeconds": 0.0,
        "decisionSeconds": 0.0,
    }
    selected_layers = None
    for item in prepared:
        decision_started = time.perf_counter()
        case = item["case"]
        prompt = item["rankPrompt"]
        actual, actual_layers, actual_forward, actual_score = contrastive.score_once(
            torch, model, prompt["actualEncoded"], device, prompt["candidateTokens"],
            prompt["probeTokens"], split_name, case["id"], "actual")
        neutral, neutral_layers, neutral_forward, neutral_score = contrastive.score_once(
            torch, model, prompt["neutralEncoded"], device, prompt["candidateTokens"],
            prompt["probeTokens"], split_name, case["id"], "neutral")
        refuse(actual_layers == neutral_layers,
               "attention-utility-ranker-pair-layer-selection-drift")
        if selected_layers is None:
            selected_layers = actual_layers
        else:
            refuse(selected_layers == actual_layers,
                   "attention-utility-ranker-trial-layer-selection-drift")
        candidates, rank_decision = contrastive.contrast_rows(actual, neutral)
        refuse(len(candidates) == len(item["order"]) and
               {row["id"] for row in candidates} == set(item["order"]),
               f"attention-utility-ranker-did-not-measure-every-fold:"
               f"{split_name}:{case['id']}")
        utility, utility_forward = score_utility_once(
            torch, model, item["utilityPrompt"]["encoded"], device, token_ids)
        decision_seconds = time.perf_counter() - decision_started
        totals["rankerActualForwardSeconds"] += actual_forward
        totals["rankerNeutralForwardSeconds"] += neutral_forward
        totals["rankerScoreAggregationSeconds"] += actual_score + neutral_score
        totals["utilityForwardSeconds"] += utility_forward
        totals["decisionSeconds"] += decision_seconds
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
            "rankQuerySha256": attention.sha256_text(ranker_query(case)),
            "rankPromptSha256": prompt["promptSha256"],
            "rankNeutralInputSha256": prompt["neutralInputSha256"],
            "utilityPromptSha256": item["utilityPrompt"]["promptSha256"],
            "rankInputTokens": prompt["inputTokens"],
            "utilityInputTokens": item["utilityPrompt"]["inputTokens"],
            "rankerActualForwardSeconds": actual_forward,
            "rankerNeutralForwardSeconds": neutral_forward,
            "rankerScoreAggregationSeconds": actual_score + neutral_score,
            "utilityForwardSeconds": utility_forward,
            "decisionSeconds": decision_seconds,
            "rankDecision": rank_decision,
            "utilityDecision": utility,
            "folds": candidates,
        })
    return trials, totals


def decision_row(trial: dict[str, Any]) -> dict[str, Any]:
    winner = min(trial["folds"], key=lambda row: row["rank"])
    relevant = set(trial["relevantFoldIds"])
    return {
        "caseId": trial["caseId"],
        "class": trial["class"],
        "eventKind": trial["eventKind"],
        "winnerId": winner["id"],
        "confidence": trial["utilityDecision"]["utilityMargin"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [point for point in sweep
                if point["offers"] >= MIN_DEVELOPMENT_OFFERS and
                point["precision"] == DEVELOPMENT_REQUIRED_PRECISION]
    selected = max(eligible, key=lambda point: (point["offers"], point["threshold"])) \
        if eligible else None
    return {
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def self_test() -> dict[str, Any]:
    utility = utility_values(3.0, 1.0)
    refuse(utility["utilityMargin"] == 2.0 and
           utility["unthresholdedChoice"] == "retrieve" and
           0.88 < utility["retrieveProbabilityWithinChoices"] < 0.89,
           "attention-utility-logit-margin-self-test-failed")
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
    refuse(selected is not None and selected["threshold"] == 0.6 and
           selected["offers"] == 4 and selected["falseOffers"] == 0,
           "attention-utility-calibration-self-test-failed")
    refuse(calibrate_threshold(decisions[1:])["selected"] is None,
           "attention-utility-minimum-offers-self-test-failed")
    wrong_fold_trial = {
        "caseId": "wrong-fold",
        "class": "positive",
        "eventKind": "stop",
        "relevantFoldIds": ["right"],
        "utilityDecision": {"utilityMargin": 4.0},
        "folds": [
            {"id": "right", "rank": 2},
            {"id": "wrong", "rank": 1},
        ],
    }
    refuse(decision_row(wrong_fold_trial)["correct"] is False,
           "attention-utility-wrong-fold-self-test-failed")
    return {
        "utilityMargin": utility["utilityMargin"],
        "unthresholdedChoice": utility["unthresholdedChoice"],
        "threshold": selected["threshold"],
        "offers": selected["offers"],
        "falseOffers": selected["falseOffers"],
        "wrongFoldOnPositiveIsFalse": True,
    }


def not_run_validation(fixture: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "not-run-no-development-threshold",
        "eventSnapshots": len(expanded_cases(fixture["splits"]["validation"])),
        "offers": None,
        "falseOffers": None,
        "precision": None,
        "recall": None,
        "confirmed": False,
    }


def run_live(args: argparse.Namespace, fixture: dict[str, Any],
             fixture_path: Path) -> dict[str, Any]:
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(args.device in {"cuda", "cpu"},
           "attention-utility-device-must-be-cuda-or-cpu")
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-utility-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(tokenizer, "is_fast", False),
           "attention-utility-needs-fast-tokenizer-offsets")
    token_ids = choice_token_ids(tokenizer)
    neutral_text, neutral_token_id = contrastive.choose_neutral_token(tokenizer)
    development_prepared = prepare_split(
        tokenizer, "development", fixture["splits"]["development"],
        config.max_position_embeddings, neutral_token_id)
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
        torch, model, args.device, "development", development_prepared, token_ids)
    development_decisions = [decision_row(trial) for trial in development_trials]
    calibration = calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(development_decisions, 0.0)
    validation_trials = []
    validation_times = {key: 0.0 for key in development_times}
    if selected is None:
        validation = not_run_validation(fixture)
    else:
        validation_prepared = prepare_split(
            tokenizer, "validation", fixture["splits"]["validation"],
            config.max_position_embeddings, neutral_token_id)
        validation_trials, validation_times = run_prepared_split(
            torch, model, args.device, "validation", validation_prepared, token_ids)
        validation_decisions = [decision_row(trial) for trial in validation_trials]
        validation = selective.decision_metrics(
            validation_decisions, selected["threshold"])
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= MIN_DEVELOPMENT_OFFERS and
            validation["falseOffers"] == 0
        )
    executed_trials = development_trials + validation_trials
    total_times = {
        key: development_times[key] + validation_times[key]
        for key in development_times
    }
    rank_tokens = [trial["rankInputTokens"] for trial in executed_trials]
    utility_tokens = [trial["utilityInputTokens"] for trial in executed_trials]
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "precision-first event utility over hierarchical fold expansions",
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "rankerScriptSha256": attention.sha256_file(
                Path(contrastive.__file__).resolve()),
            "attentionScriptSha256": attention.sha256_file(
                Path(attention.__file__).resolve()),
            "policyScriptSha256": attention.sha256_file(
                Path(selective.__file__).resolve()),
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
        "ranker": {
            "id": RANKER_ID,
            "neutralTokenText": neutral_text,
            "neutralTokenId": neutral_token_id,
            "sameTokenCount": True,
            "allFoldNodesMeasured": True,
        },
        "utility": {
            "id": UTILITY_SCORER_ID,
            "retrieveTokenText": RETRIEVE_CHOICE,
            "retrieveTokenId": token_ids["retrieve"],
            "skipTokenText": SKIP_CHOICE,
            "skipTokenId": token_ids["skip"],
            "confidenceScalar": CONFIDENCE_SCALAR,
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
            "forwardPasses": len(executed_trials) * 3,
            "meanDecisionSeconds": (
                total_times["decisionSeconds"] / len(executed_trials)
                if executed_trials else None
            ),
            "rankInputTokensMinimum": min(rank_tokens) if rank_tokens else None,
            "rankInputTokensMaximum": max(rank_tokens) if rank_tokens else None,
            "rankInputTokensMean": (
                sum(rank_tokens) / len(rank_tokens) if rank_tokens else None
            ),
            "utilityInputTokensMinimum": min(utility_tokens) if utility_tokens else None,
            "utilityInputTokensMaximum": max(utility_tokens) if utility_tokens else None,
            "utilityInputTokensMean": (
                sum(utility_tokens) / len(utility_tokens) if utility_tokens else None
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
            "Test a constrained retrieve-versus-skip utility threshold after synthetic event "
            "snapshots while ranking every complete folded node. The default dry run makes no "
            "model or network calls."
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
    refuse(fixture_path.is_file(), f"attention-utility-fixture-missing:{fixture_path}")
    fixture = load_fixture(fixture_path)
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
        sys.stderr.write(f"Attention utility probe failed: {error}\n")
        raise SystemExit(1)
