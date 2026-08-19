#!/usr/bin/env python3
"""Model-capacity falsifier for the frozen answerability-transition scorer."""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_answerability_transition as transition
import probe_attention_contrastive as contrastive
import probe_attention_selective as selective
import probe_attention_shadow as attention
import probe_attention_utility as utility


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-1.7b-nf4-answerability-transition-v1"
DEFAULT_MODEL = "Qwen/Qwen3-1.7B"
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE
DEFAULT_BASELINE = (
    PROJECT
    / "lab"
    / "attention-shadow"
    / "qwen3-0.6b-fp16-answerability-transition-v1.json"
)
QUANTIZATION = {
    "method": "bitsandbytes-nf4",
    "loadIn4Bit": True,
    "doubleQuant": True,
    "computeDtype": "torch.float16",
    "quantStorage": "torch.uint8",
}


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = transition.fixture_contract(fixture)
    return {
        **base,
        "scorerId": SCORER_ID,
        "mechanismScorerId": transition.SCORER_ID,
        "modelOnlyChange": True,
        "capacityComparison": {
            "baselineModel": "Qwen/Qwen3-0.6B",
            "candidateModel": DEFAULT_MODEL,
            "baselineParametersBillions": 0.6,
            "candidateParametersBillions": 1.7,
            "candidateToBaselineParameterRatio": 1.7 / 0.6,
            "baselinePrecisionVerdict": "rejected on development",
            "frozen": [
                "prompt text",
                "token ids",
                "expanded input ids",
                "active-only control input ids",
                "fixture",
                "labels",
                "transition bottleneck",
                "threshold policy",
                "validation lock",
            ],
            "changed": ["model weights", "model capacity", "NF4 quantization"],
        },
        "quantization": dict(QUANTIZATION),
        "baselineArtifact": str(DEFAULT_BASELINE.relative_to(PROJECT)),
        "boundary": (
            "offline model-capacity falsifier only; no prompt rewrite, score rewrite, threshold "
            "rewrite, carrier, Pi event registration, context mutation, active-context "
            "nomination, provider request, generation, batching, prefilter, cap, truncation, "
            "runtime integration, or latency optimization"
        ),
    }


def model_device_map(model: Any) -> dict[str, str]:
    reported = getattr(model, "hf_device_map", None)
    if isinstance(reported, dict) and reported:
        return {str(key): str(value) for key, value in reported.items()}
    parameter = next(model.parameters())
    return {"": str(parameter.device)}


def self_test() -> dict[str, Any]:
    base = transition.self_test()
    refuse(
        transition.SCORER_ID == "qwen3-per-fold-answerability-transition-v1"
        and transition.POLICY_ID
        == "positive-zero-false-answerability-transition-event-v1"
        and transition.CONFIDENCE_SCALAR
        == (
            "maximum per-fold minimum of expanded sufficiency margin and negated "
            "active-only sufficiency margin"
        ),
        "attention-capacity-base-contract-drift",
    )
    refuse(
        QUANTIZATION == {
            "method": "bitsandbytes-nf4",
            "loadIn4Bit": True,
            "doubleQuant": True,
            "computeDtype": "torch.float16",
            "quantStorage": "torch.uint8",
        },
        "attention-capacity-quantization-contract-drift",
    )

    class FallbackModel:
        def parameters(self):
            return iter([type("Parameter", (), {"device": "cuda:0"})()])

    fallback_device_map = model_device_map(FallbackModel())
    refuse(
        fallback_device_map == {"": "cuda:0"},
        "attention-capacity-device-map-fallback-drift",
    )
    return {
        "model": DEFAULT_MODEL,
        "modelOnlyChange": True,
        "mechanismScorerId": transition.SCORER_ID,
        "policyId": transition.POLICY_ID,
        "transitionMargin": base["transitionMargin"],
        "zeroThresholdRefused": base["zeroThresholdRefused"],
        "quantization": dict(QUANTIZATION),
        "deviceMapFallback": fallback_device_map,
    }


def load_baseline(path: Path) -> dict[str, Any]:
    refuse(path.is_file(), f"attention-capacity-baseline-missing:{path}")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    refuse(
        baseline.get("scorer", {}).get("id") == transition.SCORER_ID,
        "attention-capacity-baseline-scorer-drift",
    )
    refuse(
        baseline.get("source", {}).get("scriptSha256")
        == attention.sha256_file(Path(transition.__file__).resolve()),
        "attention-capacity-frozen-mechanism-source-drift",
    )
    refuse(
        baseline.get("validation", {}).get("status")
        == "not-run-no-development-threshold"
        and not baseline.get("splits", {}).get("validation", {}).get("trials"),
        "attention-capacity-baseline-validation-was-opened",
    )
    return baseline


def assert_development_identity(
    prepared: list[dict[str, Any]],
    baseline: dict[str, Any],
) -> dict[str, int]:
    prior = {
        (trial["caseId"], fold["id"]): fold
        for trial in baseline["splits"]["development"]["trials"]
        for fold in trial["folds"]
    }
    rows = [
        (item["case"]["id"], prompt_row["foldId"], prompt_row["prompt"])
        for item in prepared
        for prompt_row in item["prompts"]
    ]
    refuse(
        len(rows) == 320 and len(prior) == 320,
        f"attention-capacity-baseline-row-count-drift:{len(rows)}:{len(prior)}",
    )
    prompt_mismatches = 0
    expanded_mismatches = 0
    active_only_mismatches = 0
    for case_id, fold_id, prompt in rows:
        old = prior.get((case_id, fold_id))
        refuse(
            old is not None,
            f"attention-capacity-baseline-row-missing:{case_id}:{fold_id}",
        )
        prompt_mismatches += prompt["promptSha256"] != old["promptSha256"]
        expanded_mismatches += (
            prompt["expandedInputSha256"] != old["expandedInputSha256"]
        )
        active_only_mismatches += (
            prompt["activeOnlyInputSha256"] != old["activeOnlyInputSha256"]
        )
    refuse(
        prompt_mismatches == 0
        and expanded_mismatches == 0
        and active_only_mismatches == 0,
        "attention-capacity-model-swap-changed-frozen-inputs:"
        f"{prompt_mismatches}:{expanded_mismatches}:{active_only_mismatches}",
    )
    return {
        "rows": len(rows),
        "promptMismatches": prompt_mismatches,
        "expandedInputMismatches": expanded_mismatches,
        "activeOnlyInputMismatches": active_only_mismatches,
    }


def not_run_validation(fixture: dict[str, Any]) -> dict[str, Any]:
    return transition.not_run_validation(fixture)


def run_live(
    args: argparse.Namespace,
    fixture: dict[str, Any],
    fixture_path: Path,
    baseline_path: Path,
) -> dict[str, Any]:
    import bitsandbytes
    import torch
    import transformers
    from transformers import (
        AutoConfig,
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
    )

    refuse(args.device == "cuda", "attention-capacity-requires-cuda")
    refuse(torch.cuda.is_available(), "attention-capacity-cuda-unavailable")
    refuse(
        args.model == DEFAULT_MODEL,
        f"attention-capacity-model-is-frozen:{DEFAULT_MODEL}",
    )
    baseline = load_baseline(baseline_path)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-capacity-needs-fast-tokenizer-offsets",
    )
    token_ids = transition.choice_token_ids(tokenizer)
    neutral_text, neutral_token_id = contrastive.choose_neutral_token(tokenizer)
    refuse(
        token_ids["sufficient"]
        == baseline["scorer"]["sufficientTokenId"]
        and token_ids["insufficient"]
        == baseline["scorer"]["insufficientTokenId"]
        and neutral_token_id == baseline["scorer"]["neutralTokenId"],
        "attention-capacity-choice-token-drift",
    )
    development_prepared = transition.prepare_split(
        tokenizer,
        "development",
        fixture["splits"]["development"],
        config.max_position_embeddings,
        neutral_token_id,
    )
    input_identity = assert_development_identity(development_prepared, baseline)
    quantization_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_quant_storage=torch.uint8,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        quantization_config=quantization_config,
        device_map={"": 0},
        attn_implementation="eager",
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).eval()
    model_metadata = {
        "id": args.model,
        "revision": getattr(config, "_commit_hash", None),
        "parametersDtype": str(next(model.parameters()).dtype),
        "layers": int(model.config.num_hidden_layers),
        "attentionHeads": int(model.config.num_attention_heads),
        "contextTokens": int(config.max_position_embeddings),
        "attentionImplementation": "eager",
        "quantized": True,
        "quantization": dict(QUANTIZATION),
        "memoryFootprintBytes": int(model.get_memory_footprint()),
        "deviceMap": model_device_map(model),
        "generatedTokens": 0,
    }
    load_finished = time.perf_counter()
    development_trials, development_times = transition.run_prepared_split(
        torch=torch,
        model=model,
        device=args.device,
        split_name="development",
        prepared=development_prepared,
        token_ids=token_ids,
    )
    development_decisions = [
        transition.decision_row(trial) for trial in development_trials
    ]
    calibration = transition.calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(
        development_decisions,
        transition.MINIMUM_TRANSITION_THRESHOLD,
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
        validation_prepared = transition.prepare_split(
            tokenizer,
            "validation",
            fixture["splits"]["validation"],
            config.max_position_embeddings,
            neutral_token_id,
        )
        validation_trials, validation_times = transition.run_prepared_split(
            torch=torch,
            model=model,
            device=args.device,
            split_name="validation",
            prepared=validation_prepared,
            token_ids=token_ids,
        )
        validation_decisions = [
            transition.decision_row(trial) for trial in validation_trials
        ]
        validation = selective.decision_metrics(
            validation_decisions,
            selected["threshold"],
        )
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= transition.MIN_DEVELOPMENT_OFFERS
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
    boundary_tokens = [fold["boundaryCrossingTokens"] for fold in folds]
    forward_seconds = (
        total_times["expandedForwardSeconds"]
        + total_times["activeOnlyForwardSeconds"]
    )
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "frozen answerability-transition model-capacity falsifier",
        "contract": {**fixture_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "baseline": {
            "path": str(baseline_path.relative_to(PROJECT)),
            "evidenceSha256": baseline["evidenceSha256"],
            "model": baseline["model"],
            "scorer": baseline["scorer"],
            "primaryVerdict": baseline["primaryVerdict"],
            "inputIdentity": input_identity,
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "frozenMechanismScriptSha256": attention.sha256_file(
                Path(transition.__file__).resolve()
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
        "model": model_metadata,
        "scorer": {
            "id": SCORER_ID,
            "mechanismScorerId": transition.SCORER_ID,
            "policyId": transition.POLICY_ID,
            "sufficientTokenText": transition.SUFFICIENT_CHOICE,
            "sufficientTokenId": token_ids["sufficient"],
            "insufficientTokenText": transition.INSUFFICIENT_CHOICE,
            "insufficientTokenId": token_ids["insufficient"],
            "neutralTokenText": neutral_text,
            "neutralTokenId": neutral_token_id,
            "confidenceScalar": transition.CONFIDENCE_SCALAR,
            "modelOnlyChange": True,
            "allFoldNodesMeasured": True,
            "equalTokenCandidateErasure": True,
            "strictPositiveTransition": True,
            "generatedTokens": 0,
        },
        "runtime": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "bitsandbytes": bitsandbytes.__version__,
            "device": args.device,
            "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "offline": args.offline,
            "loadSeconds": load_finished - load_started,
            **total_times,
            "executedDecisions": len(executed_trials),
            "meanDecisionSeconds": (
                total_times["decisionSeconds"] / len(executed_trials)
                if executed_trials else None
            ),
            "meanForwardSeconds": (
                forward_seconds / total_times["forwardPasses"]
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
            "boundaryCrossingTokens": sum(boundary_tokens),
            "promptsWithBoundaryCrossingTokens": sum(
                count > 0 for count in boundary_tokens
            ),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakReservedBytes": torch.cuda.max_memory_reserved(),
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
            "This changes model capacity and NF4 quantization together because the larger model cannot fit this GPU in FP16.",
            "The attempted Qwen3-4B NF4 preflight did not finish loading in available VRAM and produced no scores.",
            "Two unrelated GPU processes remained active; timing is contended and nonpromotional.",
            "Synthetic snapshots represent event boundaries; no Pi event hook is registered.",
            "The fixture supplies one-level expansion projections rather than reading a live fold store.",
            "A repeated neutral token is a geometry control, not natural-language active context alone.",
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
            "Run the frozen answerability-transition scorer with Qwen3-1.7B NF4. The default "
            "dry run loads no model and makes no network request."
        )
    )
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="cuda", choices=("cuda",))
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    parser.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        print(json.dumps(self_test(), indent=2))
        return 0
    fixture_path = Path(args.fixture).expanduser().resolve()
    baseline_path = Path(args.baseline).expanduser().resolve()
    refuse(
        fixture_path.is_file(),
        f"attention-capacity-fixture-missing:{fixture_path}",
    )
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path, baseline_path)
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
        sys.stderr.write(f"Attention answerability capacity probe failed: {error}\n")
        raise SystemExit(1)
