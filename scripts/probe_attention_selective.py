#!/usr/bin/env python3
"""Precision-first abstention test over the fixed local attention scorer."""

from __future__ import annotations

import argparse
import json
import math
import platform
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_shadow as attention


PROTOCOL_VERSION = 1
POLICY_ID = "top-density-share-abstention-v1"
CONFIDENCE_SCALAR = "top candidate densityShare"
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
WILSON_ONE_SIDED_95_Z = 1.6448536269514722
NEGATIVE_CLASSES = (
    "no-relevant",
    "already-visible",
    "semantically-related-but-non-answering",
    "interruption-not-worthwhile",
)
QUERY_FIELDS = (
    ("positive", "positiveQuery"),
    ("no-relevant", "noRelevantQuery"),
    ("already-visible", "alreadyVisibleQuery"),
    ("semantically-related-but-non-answering", "nearMissQuery"),
    ("interruption-not-worthwhile", "interruptionQuery"),
)
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = PROJECT / "scripts" / "fixtures" / "attention_selective_v1.json"


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_selective_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    refuse(fixture.get("protocolVersion") == PROTOCOL_VERSION,
           "attention-selective-fixture-version-mismatch")
    splits = fixture.get("splits")
    refuse(isinstance(splits, dict) and set(splits) == {"development", "validation"},
           "attention-selective-needs-development-and-validation")
    split_ids: dict[str, set[str]] = {}
    for split_name, split in splits.items():
        candidates = split.get("candidates")
        refuse(isinstance(candidates, list) and len(candidates) >= 2,
               f"attention-selective-needs-candidates:{split_name}")
        ids = [candidate.get("id") for candidate in candidates]
        refuse(all(isinstance(candidate_id, str) and candidate_id for candidate_id in ids),
               f"attention-selective-candidate-needs-id:{split_name}")
        refuse(len(set(ids)) == len(ids),
               f"attention-selective-candidate-ids-must-be-unique:{split_name}")
        split_ids[split_name] = set(ids)
        for candidate in candidates:
            refuse(isinstance(candidate.get("content"), str) and candidate["content"].strip(),
                   f"attention-selective-candidate-needs-content:{candidate.get('id')}")
            for _, field in QUERY_FIELDS:
                refuse(isinstance(candidate.get(field), str) and candidate[field].strip(),
                       f"attention-selective-candidate-needs-{field}:{candidate.get('id')}")
    refuse(split_ids["development"].isdisjoint(split_ids["validation"]),
           "attention-selective-split-candidate-overlap")
    return fixture


def expanded_cases(split: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = split["candidates"]
    count = len(candidates)
    rows = []
    for candidate_index, candidate in enumerate(candidates):
        for class_index, (case_class, field) in enumerate(QUERY_FIELDS):
            rotation = (2 * candidate_index + class_index) % count
            rows.append({
                "id": f"{case_class}-{candidate['id']}",
                "class": case_class,
                "query": candidate[field],
                "rotation": rotation,
                "themeCandidateId": candidate["id"],
                "relevantCandidateIds": [candidate["id"]] if case_class == "positive" else [],
            })
    return rows


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    split_rows = {}
    for name, split in fixture["splits"].items():
        cases = expanded_cases(split)
        counts = {case_class: sum(case["class"] == case_class for case in cases)
                  for case_class, _ in QUERY_FIELDS}
        refuse(sum(counts[name] for name in NEGATIVE_CLASSES) > counts["positive"],
               f"attention-selective-negatives-must-dominate:{name}")
        split_rows[name] = {
            "candidates": len(split["candidates"]),
            "turns": len(cases),
            "classes": counts,
            "positiveRate": counts["positive"] / len(cases),
        }
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "scorerId": attention.SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "candidateSelection": "all supplied candidates in every forward pass",
        "candidateContent": "complete supplied content",
        "inputTruncation": False,
        "prefilter": None,
        "generationCalls": 0,
        "providerCalls": 0,
        "labelsVisibleToScorer": False,
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "selection": "lowest threshold with zero false offers and the most offers",
        },
        "validation": "threshold frozen before validation labels are evaluated",
        "splits": split_rows,
        "boundary": (
            "experiment only; no carrier, runtime mutation, scorer change, active-context "
            "nomination, or threshold promotion"
        ),
    }


def decision_row(trial: dict[str, Any]) -> dict[str, Any]:
    winner = min(trial["candidates"], key=lambda row: row["rank"])
    relevant = set(trial["relevantCandidateIds"])
    return {
        "caseId": trial["caseId"],
        "class": trial["class"],
        "winnerId": winner["id"],
        "confidence": winner["densityShare"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def decision_metrics(decisions: list[dict[str, Any]], threshold: float | None) -> dict[str, Any]:
    offers = [] if threshold is None else [row for row in decisions if row["confidence"] >= threshold]
    correct = sum(row["correct"] for row in offers)
    false = len(offers) - correct
    opportunities = sum(row["opportunity"] for row in decisions)
    false_by_class = {
        case_class: sum(row["class"] == case_class and not row["correct"] for row in offers)
        for case_class in (*NEGATIVE_CLASSES, "positive")
    }
    return {
        "threshold": threshold,
        "turns": len(decisions),
        "offers": len(offers),
        "correctOffers": correct,
        "falseOffers": false,
        "precision": correct / len(offers) if offers else None,
        "offerRate": len(offers) / len(decisions),
        "opportunities": opportunities,
        "usefulOffers": correct,
        "recall": correct / opportunities if opportunities else None,
        "falseOffersByClass": false_by_class,
        "oneSided95WilsonPrecisionLower": wilson_lower(correct, len(offers)),
        "offeredCaseIds": [row["caseId"] for row in offers],
    }


def wilson_lower(successes: int, trials: int) -> float | None:
    if trials == 0:
        return None
    z = WILSON_ONE_SIDED_95_Z
    proportion = successes / trials
    denominator = 1 + z * z / trials
    center = proportion + z * z / (2 * trials)
    spread = z * math.sqrt(proportion * (1 - proportion) / trials + z * z / (4 * trials * trials))
    return (center - spread) / denominator


def threshold_sweep(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [decision_metrics(decisions, threshold)
            for threshold in sorted({row["confidence"] for row in decisions}, reverse=True)]


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = threshold_sweep(decisions)
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
        {"caseId": "e", "class": "no-relevant", "confidence": 0.5,
         "correct": False, "opportunity": False},
    ]
    selected = calibrate_threshold(fixture)["selected"]
    refuse(selected is not None and selected["threshold"] == 0.6 and selected["offers"] == 4,
           "attention-selective-calibration-self-test-failed")
    refuse(calibrate_threshold(fixture[1:])["selected"] is None,
           "attention-selective-minimum-offers-self-test-failed")
    return {"threshold": selected["threshold"], "offers": selected["offers"],
            "precision": selected["precision"]}


def prepare_split(tokenizer: Any, split_name: str, split: dict[str, Any],
                  context_tokens: int) -> list[dict[str, Any]]:
    candidates_by_id = {candidate["id"]: candidate for candidate in split["candidates"]}
    ids = list(candidates_by_id)
    orders = attention.rotations(ids)
    prepared = []
    for case in expanded_cases(split):
        order = orders[case["rotation"]]
        prompt = attention.prepare_prompt(tokenizer, candidates_by_id, order, case["query"])
        refuse(prompt["inputTokens"] <= context_tokens,
               f"attention-selective-input-exceeds-model-context:{split_name}:{case['id']}:"
               f"{prompt['inputTokens']}:{context_tokens}")
        prepared.append({"case": case, "order": order, "prompt": prompt})
    return prepared


def run_prepared_split(torch: Any, model: Any, device: str, split_name: str,
                       prepared: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float]:
    trials = []
    total_seconds = 0.0
    selected_layers = None
    for item in prepared:
        prompt = item["prompt"]
        encoded = {key: value.to(device) for key, value in prompt["encoded"].items()}
        if device == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            outputs = model(**encoded, use_cache=False, output_attentions=True, return_dict=True)
        if device == "cuda":
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        total_seconds += elapsed
        attentions = outputs.attentions
        refuse(attentions is not None and len(attentions) == model.config.num_hidden_layers,
               f"attention-selective-incomplete-attention-stack:{split_name}:{item['case']['id']}")
        scores, layers = attention.score_attentions(
            attentions, prompt["candidateTokens"], prompt["probeTokens"])
        if selected_layers is None:
            selected_layers = layers
        else:
            refuse(selected_layers == layers, "attention-selective-layer-selection-drift")
        case = item["case"]
        trials.append({
            "caseId": case["id"],
            "class": case["class"],
            "rotation": case["rotation"],
            "order": item["order"],
            "themeCandidateId": case["themeCandidateId"],
            "relevantCandidateIds": case["relevantCandidateIds"],
            "querySha256": attention.sha256_text(case["query"]),
            "promptSha256": prompt["promptSha256"],
            "inputTokens": prompt["inputTokens"],
            "forwardSeconds": elapsed,
            "candidates": scores,
        })
        del attentions, outputs, encoded
    return trials, total_seconds


def run_live(args: argparse.Namespace, fixture: dict[str, Any], fixture_path: Path) -> dict[str, Any]:
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(args.device in {"cuda", "cpu"}, "attention-selective-device-must-be-cuda-or-cpu")
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-selective-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(tokenizer, "is_fast", False), "attention-selective-needs-fast-tokenizer-offsets")
    prepared = {
        name: prepare_split(tokenizer, name, split, config.max_position_embeddings)
        for name, split in fixture["splits"].items()
    }
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        dtype=dtype,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).to(args.device).eval()
    load_finished = time.perf_counter()
    development_trials, development_seconds = run_prepared_split(
        torch, model, args.device, "development", prepared["development"])
    development_decisions = [decision_row(trial) for trial in development_trials]
    calibration = calibrate_threshold(development_decisions)
    threshold = calibration["selected"]["threshold"] if calibration["selected"] else None
    validation_trials, validation_seconds = run_prepared_split(
        torch, model, args.device, "validation", prepared["validation"])
    validation_decisions = [decision_row(trial) for trial in validation_trials]
    validation = decision_metrics(validation_decisions, threshold)
    all_trials = development_trials + validation_trials
    input_tokens = [trial["inputTokens"] for trial in all_trials]
    forwards = len(all_trials)
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "precision-first local attention abstention",
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "scorerScriptSha256": attention.sha256_file(Path(attention.__file__).resolve()),
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
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "device": args.device,
            "cuda": torch.version.cuda if args.device == "cuda" else None,
            "gpu": torch.cuda.get_device_name(0) if args.device == "cuda" else None,
            "offline": args.offline,
            "loadSeconds": load_finished - load_started,
            "developmentForwardSeconds": development_seconds,
            "validationForwardSeconds": validation_seconds,
            "totalForwardSeconds": development_seconds + validation_seconds,
            "meanForwardSeconds": (development_seconds + validation_seconds) / forwards,
            "forwardPasses": forwards,
            "inputTokensMinimum": min(input_tokens),
            "inputTokensMaximum": max(input_tokens),
            "inputTokensMean": sum(input_tokens) / len(input_tokens),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated() if args.device == "cuda" else None,
            "peakReservedBytes": torch.cuda.max_memory_reserved() if args.device == "cuda" else None,
        },
        "calibration": calibration,
        "validation": validation,
        "limitations": [
            "Synthetic turns test the decision shape, not production prevalence or semantic labels.",
            "Development chooses the threshold; only validation estimates its transfer.",
            "Candidate count is fixed within both splits, so confidence transfer across candidate counts is unmeasured.",
            "The scorer still carries the protocol-1 position bias; abstention may reject but cannot correct a wrong winner.",
            "No runtime carrier or active-context fold nomination is exercised.",
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
            "Calibrate rare attention offers on development and evaluate the frozen threshold "
            "on disjoint validation. The default dry run makes no model or network calls."
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
        print(json.dumps(calibration_self_test(), indent=2))
        return 0
    fixture_path = Path(args.fixture).expanduser().resolve()
    refuse(fixture_path.is_file(), f"attention-selective-fixture-missing:{fixture_path}")
    fixture = load_selective_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path)
    else:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "contract": {**fixture_contract(fixture), "model": args.model},
            "fixtureSha256": attention.sha256_file(fixture_path),
            "calibrationSelfTest": calibration_self_test(),
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
            "runtime": report.get("runtime"),
        }, indent=2))
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, RuntimeError) as error:
        sys.stderr.write(f"Attention selective probe failed: {error}\n")
        raise SystemExit(1)
