#!/usr/bin/env python3
"""Precision-first query-erasure contrast over the local attention scorer."""

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


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-query-erasure-attention-v1"
POLICY_ID = "zero-false-joint-action-v1"
CONFIDENCE_SCALAR = "minimum of top query lift and top-minus-second query-lift margin"
NEUTRAL_TOKEN_CANDIDATES = (" unknown", " neutral", " unrelated", ".")
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = PROJECT / "scripts" / "fixtures" / "attention_contrastive_v1.json"


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_fixture(path: Path) -> dict[str, Any]:
    fixture = selective.load_selective_fixture(path)
    refuse(fixture.get("fixtureId") == "query-erasure-joint-precision-v1",
           "attention-contrastive-fixture-id-mismatch")
    return fixture


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = selective.fixture_contract(fixture)
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "scorerId": SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "candidateSelection": base["candidateSelection"],
        "candidateContent": base["candidateContent"],
        "inputTruncation": False,
        "prefilter": None,
        "forwardsPerDecision": 2,
        "contrast": (
            "log attention-density ratio between the actual query and an equal-length "
            "query-erased baseline at identical token positions"
        ),
        "jointCorrectOffer": (
            "retrieval is worthwhile and the selected candidate belongs to the relevant set"
        ),
        "everyOtherOffer": "false, including a wrong candidate on a positive turn",
        "generationCalls": 0,
        "providerCalls": 0,
        "labelsVisibleToScorer": False,
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": selective.DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": selective.MIN_DEVELOPMENT_OFFERS,
            "selection": "lowest threshold with zero false offers and the most offers",
        },
        "validation": (
            "not run unless development selects a threshold; selected threshold frozen"
        ),
        "primaryOutcome": "zero false offers at nonzero anti-vacuous held-out coverage",
        "nonPromotionalDiagnostics": ["recall", "offer rate", "latency", "memory"],
        "splits": base["splits"],
        "boundary": (
            "experiment only; one scorer change, no carrier, runtime mutation, active-context "
            "nomination, threshold promotion, quantization, or latency optimization"
        ),
    }


def choose_neutral_token(tokenizer: Any) -> tuple[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    for text in NEUTRAL_TOKEN_CANDIDATES:
        ids = tokenizer.encode(text, add_special_tokens=False)
        if len(ids) == 1 and ids[0] not in special_ids:
            return text, int(ids[0])
    raise ValueError("attention-contrastive-needs-one-neutral-token")


def prepare_paired_prompt(tokenizer: Any, candidates_by_id: dict[str, dict[str, Any]],
                          order: list[str], query: str,
                          neutral_token_id: int) -> dict[str, Any]:
    user_text, user_spans = attention.build_user_prompt(candidates_by_id, order, query)
    query_marker = "<QUERY>\n"
    query_start = user_text.rfind(query_marker)
    refuse(query_start >= 0, "attention-contrastive-query-marker-missing")
    query_start += len(query_marker)
    query_end = query_start + len(query)
    refuse(user_text[query_start:query_end] == query,
           "attention-contrastive-query-span-mismatch")
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": user_text}],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    user_start = rendered.find(user_text)
    refuse(user_start >= 0, "attention-contrastive-chat-template-lost-user-content")
    cue_start = len(rendered)
    full_prompt = rendered + attention.READOUT_CUE
    encoded = tokenizer(
        full_prompt,
        add_special_tokens=False,
        truncation=False,
        return_offsets_mapping=True,
        return_tensors="pt",
    )
    offsets = [tuple(pair) for pair in encoded.pop("offset_mapping")[0].tolist()]
    candidate_tokens = {}
    for candidate_id, (start, end) in user_spans.items():
        positions = attention.overlapping_token_positions(
            offsets, user_start + start, user_start + end)
        refuse(bool(positions), f"attention-contrastive-empty-token-span:{candidate_id}")
        candidate_tokens[candidate_id] = positions
    query_tokens = attention.overlapping_token_positions(
        offsets, user_start + query_start, user_start + query_end)
    probe_tokens = attention.overlapping_token_positions(offsets, cue_start, len(full_prompt))
    refuse(bool(query_tokens), "attention-contrastive-empty-query-token-span")
    refuse(bool(probe_tokens), "attention-contrastive-empty-readout-token-span")
    covered = [position for positions in candidate_tokens.values() for position in positions]
    refuse(len(covered) == len(set(covered)),
           "attention-contrastive-overlapping-candidate-spans")
    neutral_encoded = {key: value.clone() for key, value in encoded.items()}
    neutral_encoded["input_ids"][0, query_tokens] = neutral_token_id
    refuse(neutral_encoded["input_ids"].shape == encoded["input_ids"].shape,
           "attention-contrastive-neutral-geometry-drift")
    refuse(all(int(neutral_encoded["input_ids"][0, position]) == neutral_token_id
               for position in query_tokens),
           "attention-contrastive-query-erasure-incomplete")
    return {
        "actualEncoded": encoded,
        "neutralEncoded": neutral_encoded,
        "promptSha256": attention.sha256_text(full_prompt),
        "neutralInputSha256": attention.sha256_text(json.dumps(
            neutral_encoded["input_ids"][0].tolist(), separators=(",", ":"))),
        "inputTokens": int(encoded["input_ids"].shape[1]),
        "queryTokens": len(query_tokens),
        "candidateTokens": candidate_tokens,
        "probeTokens": probe_tokens,
    }


def contrast_rows(actual_rows: list[dict[str, Any]],
                  neutral_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    actual = {row["id"]: row for row in actual_rows}
    neutral = {row["id"]: row for row in neutral_rows}
    refuse(set(actual) == set(neutral) and len(actual) >= 2,
           "attention-contrastive-candidate-set-drift")
    rows = []
    for candidate_id in sorted(actual):
        actual_density = actual[candidate_id]["attentionDensity"]
        neutral_density = neutral[candidate_id]["attentionDensity"]
        refuse(actual_density > 0 and neutral_density > 0,
               f"attention-contrastive-nonpositive-density:{candidate_id}")
        rows.append({
            "id": candidate_id,
            "tokenCount": actual[candidate_id]["tokenCount"],
            "actualAttentionDensity": actual_density,
            "neutralAttentionDensity": neutral_density,
            "queryLift": math.log(actual_density / neutral_density),
        })
    ordered = sorted(rows, key=lambda row: (-row["queryLift"], row["id"]))
    ranks = {row["id"]: index + 1 for index, row in enumerate(ordered)}
    top = ordered[0]
    second = ordered[1]
    margin = top["queryLift"] - second["queryLift"]
    confidence = min(top["queryLift"], margin)
    return ([{**row, "rank": ranks[row["id"]]} for row in rows], {
        "winnerId": top["id"],
        "topQueryLift": top["queryLift"],
        "secondQueryLift": second["queryLift"],
        "queryLiftMargin": margin,
        "confidence": confidence,
    })


def contrast_self_test() -> dict[str, Any]:
    actual = [
        {"id": "first", "tokenCount": 10, "attentionDensity": 0.8},
        {"id": "target", "tokenCount": 10, "attentionDensity": 0.3},
        {"id": "other", "tokenCount": 10, "attentionDensity": 0.1},
    ]
    neutral = [
        {"id": "first", "tokenCount": 10, "attentionDensity": 0.8},
        {"id": "target", "tokenCount": 10, "attentionDensity": 0.1},
        {"id": "other", "tokenCount": 10, "attentionDensity": 0.1},
    ]
    rows, decision = contrast_rows(actual, neutral)
    refuse(decision["winnerId"] == "target" and decision["confidence"] > 0,
           "attention-contrastive-position-cancellation-self-test-failed")
    reversed_rows, reversed_decision = contrast_rows(
        list(reversed(actual)), list(reversed(neutral)))
    refuse(rows == reversed_rows and decision == reversed_decision,
           "attention-contrastive-order-invariance-self-test-failed")
    return {
        "winnerId": decision["winnerId"],
        "confidencePositive": decision["confidence"] > 0,
        "orderInvariant": True,
    }


def decision_row(trial: dict[str, Any]) -> dict[str, Any]:
    winner = min(trial["candidates"], key=lambda row: row["rank"])
    relevant = set(trial["relevantCandidateIds"])
    return {
        "caseId": trial["caseId"],
        "class": trial["class"],
        "winnerId": winner["id"],
        "confidence": trial["decision"]["confidence"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [point for point in sweep
                if point["offers"] >= selective.MIN_DEVELOPMENT_OFFERS and
                point["precision"] == selective.DEVELOPMENT_REQUIRED_PRECISION]
    selected = max(eligible, key=lambda point: (point["offers"], point["threshold"])) \
        if eligible else None
    return {
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def calibration_self_test() -> dict[str, Any]:
    fixture = [
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
    selected = calibrate_threshold(fixture)["selected"]
    refuse(selected is not None and selected["threshold"] == 0.6 and
           selected["offers"] == 4 and selected["falseOffers"] == 0,
           "attention-contrastive-calibration-self-test-failed")
    refuse(calibrate_threshold(fixture[1:])["selected"] is None,
           "attention-contrastive-minimum-offers-self-test-failed")
    return {"threshold": 0.6, "offers": 4, "falseOffers": 0}


def prepare_split(tokenizer: Any, split_name: str, split: dict[str, Any],
                  context_tokens: int, neutral_token_id: int) -> list[dict[str, Any]]:
    candidates_by_id = {candidate["id"]: candidate for candidate in split["candidates"]}
    ids = list(candidates_by_id)
    orders = attention.rotations(ids)
    prepared = []
    for case in selective.expanded_cases(split):
        order = orders[case["rotation"]]
        prompt = prepare_paired_prompt(
            tokenizer, candidates_by_id, order, case["query"], neutral_token_id)
        refuse(prompt["inputTokens"] <= context_tokens,
               f"attention-contrastive-input-exceeds-model-context:{split_name}:"
               f"{case['id']}:{prompt['inputTokens']}:{context_tokens}")
        prepared.append({"case": case, "order": order, "prompt": prompt})
    return prepared


def score_once(torch: Any, model: Any, encoded: dict[str, Any], device: str,
               candidate_tokens: dict[str, list[int]], probe_tokens: list[int],
               split_name: str, case_id: str, variant: str) -> tuple[list[dict[str, Any]], list[int], float, float]:
    device_encoded = {key: value.to(device) for key, value in encoded.items()}
    if device == "cuda":
        torch.cuda.synchronize()
    forward_started = time.perf_counter()
    with torch.inference_mode():
        outputs = model(
            **device_encoded, use_cache=False, output_attentions=True, return_dict=True)
    if device == "cuda":
        torch.cuda.synchronize()
    forward_seconds = time.perf_counter() - forward_started
    attentions = outputs.attentions
    refuse(attentions is not None and len(attentions) == model.config.num_hidden_layers,
           f"attention-contrastive-incomplete-attention-stack:{split_name}:"
           f"{case_id}:{variant}")
    score_started = time.perf_counter()
    scores, layers = attention.score_attentions(attentions, candidate_tokens, probe_tokens)
    if device == "cuda":
        torch.cuda.synchronize()
    score_seconds = time.perf_counter() - score_started
    del attentions, outputs, device_encoded
    return scores, layers, forward_seconds, score_seconds


def run_prepared_split(torch: Any, model: Any, device: str, split_name: str,
                       prepared: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, float]]:
    trials = []
    totals = {"actualForwardSeconds": 0.0, "neutralForwardSeconds": 0.0,
              "scoreAggregationSeconds": 0.0, "decisionSeconds": 0.0}
    selected_layers = None
    for item in prepared:
        decision_started = time.perf_counter()
        prompt = item["prompt"]
        case = item["case"]
        actual, actual_layers, actual_forward, actual_score = score_once(
            torch, model, prompt["actualEncoded"], device, prompt["candidateTokens"],
            prompt["probeTokens"], split_name, case["id"], "actual")
        neutral, neutral_layers, neutral_forward, neutral_score = score_once(
            torch, model, prompt["neutralEncoded"], device, prompt["candidateTokens"],
            prompt["probeTokens"], split_name, case["id"], "neutral")
        refuse(actual_layers == neutral_layers,
               "attention-contrastive-pair-layer-selection-drift")
        if selected_layers is None:
            selected_layers = actual_layers
        else:
            refuse(selected_layers == actual_layers,
                   "attention-contrastive-trial-layer-selection-drift")
        candidates, decision = contrast_rows(actual, neutral)
        decision_seconds = time.perf_counter() - decision_started
        totals["actualForwardSeconds"] += actual_forward
        totals["neutralForwardSeconds"] += neutral_forward
        totals["scoreAggregationSeconds"] += actual_score + neutral_score
        totals["decisionSeconds"] += decision_seconds
        trials.append({
            "caseId": case["id"],
            "class": case["class"],
            "rotation": case["rotation"],
            "order": item["order"],
            "themeCandidateId": case["themeCandidateId"],
            "relevantCandidateIds": case["relevantCandidateIds"],
            "querySha256": attention.sha256_text(case["query"]),
            "promptSha256": prompt["promptSha256"],
            "neutralInputSha256": prompt["neutralInputSha256"],
            "inputTokens": prompt["inputTokens"],
            "queryTokens": prompt["queryTokens"],
            "actualForwardSeconds": actual_forward,
            "neutralForwardSeconds": neutral_forward,
            "scoreAggregationSeconds": actual_score + neutral_score,
            "decisionSeconds": decision_seconds,
            "decision": decision,
            "candidates": candidates,
        })
    return trials, totals


def not_run_validation(fixture: dict[str, Any]) -> dict[str, Any]:
    cases = selective.expanded_cases(fixture["splits"]["validation"])
    return {
        "status": "not-run-no-development-threshold",
        "turns": len(cases),
        "offers": None,
        "falseOffers": None,
        "precision": None,
        "recall": None,
        "confirmed": False,
    }


def run_live(args: argparse.Namespace, fixture: dict[str, Any], fixture_path: Path) -> dict[str, Any]:
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(args.device in {"cuda", "cpu"},
           "attention-contrastive-device-must-be-cuda-or-cpu")
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-contrastive-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(tokenizer, "is_fast", False),
           "attention-contrastive-needs-fast-tokenizer-offsets")
    neutral_text, neutral_token_id = choose_neutral_token(tokenizer)
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
        torch, model, args.device, "development", development_prepared)
    development_decisions = [decision_row(trial) for trial in development_trials]
    calibration = calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    validation_trials = []
    validation_times = {key: 0.0 for key in development_times}
    if selected is None:
        validation = not_run_validation(fixture)
    else:
        validation_prepared = prepare_split(
            tokenizer, "validation", fixture["splits"]["validation"],
            config.max_position_embeddings, neutral_token_id)
        validation_trials, validation_times = run_prepared_split(
            torch, model, args.device, "validation", validation_prepared)
        validation_decisions = [decision_row(trial) for trial in validation_trials]
        validation = selective.decision_metrics(
            validation_decisions, selected["threshold"])
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= selective.MIN_DEVELOPMENT_OFFERS and
            validation["falseOffers"] == 0
        )
    executed_trials = development_trials + validation_trials
    input_tokens = [trial["inputTokens"] for trial in executed_trials]
    total_times = {
        key: development_times[key] + validation_times[key]
        for key in development_times
    }
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "precision-first query-erasure attention contrast",
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "baseScorerScriptSha256": attention.sha256_file(
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
        "queryErasure": {
            "neutralTokenText": neutral_text,
            "neutralTokenId": neutral_token_id,
            "sameTokenCount": True,
            "sameCandidatePositions": True,
            "sameReadoutPositions": True,
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
            "forwardPasses": len(executed_trials) * 2,
            "meanDecisionSeconds": (
                total_times["decisionSeconds"] / len(executed_trials)
                if executed_trials else None
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
        "calibration": calibration,
        "validation": validation,
        "primaryVerdict": {
            "confirmed": bool(validation.get("confirmed")),
            "rule": (
                "at least four held-out offers, every offer jointly worthwhile and correct"
            ),
            "recallCanPromote": False,
            "latencyCanPromote": False,
        },
        "limitations": [
            "Synthetic turns test selective action shape, not production prevalence.",
            "One neutral token repeated over the query is a mechanistic geometry control, not natural language.",
            "A minimum of four offers prevents a singleton pass but cannot establish production precision.",
            "No carrier, runtime behavior, or active-context fold nomination is exercised.",
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
            "Test whether query-erased attention contrast has a zero-false selective point. "
            "The default dry run makes no model or network calls."
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
        print(json.dumps({
            "contrast": contrast_self_test(),
            "calibration": calibration_self_test(),
        }, indent=2))
        return 0
    fixture_path = Path(args.fixture).expanduser().resolve()
    refuse(fixture_path.is_file(), f"attention-contrastive-fixture-missing:{fixture_path}")
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
            "selfTest": {
                "contrast": contrast_self_test(),
                "calibration": calibration_self_test(),
            },
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
        sys.stderr.write(f"Attention contrastive probe failed: {error}\n")
        raise SystemExit(1)
