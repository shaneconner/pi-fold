#!/usr/bin/env python3
"""Held-out validation for the frozen Granite source-attribution threshold."""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_answerability_capacity as capacity
import probe_attention_selective as selective
import probe_attention_shadow as attention
import probe_attention_source_attribution as source_attribution
import probe_attention_source_family as source_family
import probe_attention_utility as utility


PROTOCOL_VERSION = 1
SCORER_ID = "granite3.3-per-fold-source-attribution-heldout-v1"
POLICY_ID = source_attribution.POLICY_ID
DEFAULT_MODEL = source_family.DEFAULT_MODEL
EXPECTED_REVISION = source_family.EXPECTED_REVISION
EXPECTED_THRESHOLD = 8.625
EXPECTED_DEVELOPMENT_EVIDENCE_SHA256 = (
    "546a68c2fc2e7fef6d72b3e8996cc0e64721b82082794e5fd7488561c8381dd7"
)
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE
DEFAULT_DEVELOPMENT = (
    PROJECT
    / "lab"
    / "attention-shadow"
    / "granite3.3-2b-nf4-source-attribution-v1.json"
)
QUANTIZATION = dict(source_family.QUANTIZATION)


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = source_family.fixture_contract(fixture)
    return {
        **base,
        "scorerId": SCORER_ID,
        "policyId": POLICY_ID,
        "phase": "held-out validation only",
        "frozenThreshold": EXPECTED_THRESHOLD,
        "developmentArtifact": str(DEFAULT_DEVELOPMENT.relative_to(PROJECT)),
        "developmentEvidenceSha256": EXPECTED_DEVELOPMENT_EVIDENCE_SHA256,
        "developmentCalibration": {
            "threshold": EXPECTED_THRESHOLD,
            "offers": 5,
            "correctOffers": 5,
            "falseOffers": 0,
            "precision": 1.0,
            "recall": 0.625,
        },
        "validation": (
            "score the untouched validation split once at threshold 8.625; do not "
            "recalibrate, rescore development, or change the threshold"
        ),
        "primaryOutcome": (
            "at least four held-out offers with zero false offers at the frozen "
            "development threshold"
        ),
        "boundary": (
            "offline held-out validation only; no development rescore, recalibration, "
            "threshold rewrite, source-label rewrite, semantic prompt rewrite, score "
            "rewrite, carrier, Pi event registration, context mutation, active-context "
            "nomination, provider request, generation, batching, prefilter, cap, "
            "truncation, runtime integration, or latency optimization"
        ),
    }


def load_development(path: Path) -> dict[str, Any]:
    refuse(path.is_file(), f"attention-source-validation-development-missing:{path}")
    development = json.loads(path.read_text(encoding="utf-8"))
    stable = dict(development)
    claimed = stable.pop("evidenceSha256", None)
    refuse(
        claimed == EXPECTED_DEVELOPMENT_EVIDENCE_SHA256
        and attention.stable_sha256(stable) == claimed,
        "attention-source-validation-development-evidence-drift",
    )
    refuse(
        development.get("scorer", {}).get("id") == source_family.SCORER_ID
        and development.get("source", {}).get("scriptSha256")
        == attention.sha256_file(Path(source_family.__file__).resolve()),
        "attention-source-validation-development-source-drift",
    )
    selected = development.get("calibration", {}).get("selected")
    refuse(
        selected is not None
        and selected.get("threshold") == EXPECTED_THRESHOLD
        and selected.get("offers") == 5
        and selected.get("correctOffers") == 5
        and selected.get("falseOffers") == 0
        and selected.get("precision") == 1.0
        and selected.get("recall") == 0.625,
        "attention-source-validation-calibration-drift",
    )
    refuse(
        development.get("validation", {}).get("status")
        == "pending-frozen-development-threshold"
        and development.get("validation", {}).get("threshold")
        == EXPECTED_THRESHOLD
        and not development.get("splits", {}).get("validation", {}).get("trials"),
        "attention-source-validation-development-opened-validation",
    )
    return development


def self_test() -> dict[str, Any]:
    base = source_family.self_test()
    refuse(
        base["modelFamilyOnlyChange"] is True
        and base["mechanismScorerId"] == source_attribution.SCORER_ID
        and base["policyId"] == POLICY_ID,
        "attention-source-validation-base-contract-drift",
    )
    development_point = {
        "threshold": EXPECTED_THRESHOLD,
        "offers": 5,
        "correctOffers": 5,
        "falseOffers": 0,
        "precision": 1.0,
        "recall": 0.625,
    }
    passing = {
        "offers": 4,
        "falseOffers": 0,
    }
    failing = {
        "offers": 3,
        "falseOffers": 0,
    }
    refuse(
        passing["offers"] >= source_attribution.MIN_DEVELOPMENT_OFFERS
        and passing["falseOffers"] == 0
        and not (
            failing["offers"] >= source_attribution.MIN_DEVELOPMENT_OFFERS
            and failing["falseOffers"] == 0
        ),
        "attention-source-validation-confirmation-self-test-failed",
    )
    return {
        "model": DEFAULT_MODEL,
        "revision": EXPECTED_REVISION,
        "developmentEvidenceSha256": EXPECTED_DEVELOPMENT_EVIDENCE_SHA256,
        "developmentPoint": development_point,
        "validationOnly": True,
        "minimumHeldOutOffers": source_attribution.MIN_DEVELOPMENT_OFFERS,
        "passingConfirmed": True,
        "threeOffersRefused": True,
        "choiceTokenIds": dict(source_family.EXPECTED_CHOICE_TOKEN_IDS),
        "quantization": dict(QUANTIZATION),
    }


def run_live(
    args: argparse.Namespace,
    fixture: dict[str, Any],
    fixture_path: Path,
    development_path: Path,
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

    refuse(args.device == "cuda", "attention-source-validation-requires-cuda")
    refuse(torch.cuda.is_available(), "attention-source-validation-cuda-unavailable")
    refuse(
        args.model == DEFAULT_MODEL,
        f"attention-source-validation-model-is-frozen:{DEFAULT_MODEL}",
    )
    development = load_development(development_path)
    selected = development["calibration"]["selected"]
    threshold = selected["threshold"]
    refuse(
        threshold == EXPECTED_THRESHOLD,
        f"attention-source-validation-threshold-drift:{threshold}",
    )
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        getattr(config, "_commit_hash", None) == EXPECTED_REVISION,
        f"attention-source-validation-model-revision-drift:"
        f"{getattr(config, '_commit_hash', None)}",
    )
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-source-validation-needs-fast-tokenizer",
    )
    token_ids = source_family.choice_token_ids(tokenizer)
    validation_prepared = source_attribution.prepare_split(
        tokenizer,
        "validation",
        fixture["splits"]["validation"],
        config.max_position_embeddings,
    )
    input_contract = source_family.prepared_contract(validation_prepared)
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
        "modelType": str(model.config.model_type),
        "parameters": int(model.num_parameters()),
        "parametersDtype": str(next(model.parameters()).dtype),
        "layers": int(model.config.num_hidden_layers),
        "attentionHeads": int(model.config.num_attention_heads),
        "contextTokens": int(config.max_position_embeddings),
        "attentionImplementation": "eager",
        "quantized": True,
        "quantization": dict(QUANTIZATION),
        "memoryFootprintBytes": int(model.get_memory_footprint()),
        "deviceMap": capacity.model_device_map(model),
        "generatedTokens": 0,
    }
    load_finished = time.perf_counter()
    validation_trials, validation_times = source_attribution.run_prepared_split(
        torch=torch,
        model=model,
        device=args.device,
        split_name="validation",
        prepared=validation_prepared,
        token_ids=token_ids,
    )
    validation_decisions = [
        source_attribution.decision_row(trial) for trial in validation_trials
    ]
    validation = selective.decision_metrics(validation_decisions, threshold)
    validation["status"] = "evaluated-with-frozen-development-threshold"
    validation["confirmed"] = (
        validation["offers"] >= source_attribution.MIN_DEVELOPMENT_OFFERS
        and validation["falseOffers"] == 0
    )
    folds = [fold for trial in validation_trials for fold in trial["folds"]]
    input_tokens = [fold["inputTokens"] for fold in folds]
    candidate_tokens = [fold["candidateTokens"] for fold in folds]
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "Granite source-attribution held-out validation",
        "contract": fixture_contract(fixture),
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": attention.sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "development": {
            "path": str(development_path.relative_to(PROJECT)),
            "fileSha256": attention.sha256_file(development_path),
            "evidenceSha256": development["evidenceSha256"],
            "source": development["source"],
            "model": development["model"],
            "scorer": development["scorer"],
            "calibrationSelected": selected,
            "primaryVerdict": development["primaryVerdict"],
            "validationBeforeThisRun": development["validation"],
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
            "frozenFamilyScriptSha256": attention.sha256_file(
                Path(source_family.__file__).resolve()
            ),
            "frozenMechanismScriptSha256": attention.sha256_file(
                Path(source_attribution.__file__).resolve()
            ),
            "fixtureLoaderScriptSha256": attention.sha256_file(
                Path(utility.__file__).resolve()
            ),
            "policyScriptSha256": attention.sha256_file(
                Path(selective.__file__).resolve()
            ),
        },
        "model": model_metadata,
        "scorer": {
            "id": SCORER_ID,
            "developmentScorerId": source_family.SCORER_ID,
            "mechanismScorerId": source_attribution.SCORER_ID,
            "policyId": POLICY_ID,
            "candidateTokenText": source_attribution.CANDIDATE_CHOICE,
            "candidateTokenId": token_ids["candidate"],
            "activeTokenText": source_attribution.ACTIVE_CHOICE,
            "activeTokenId": token_ids["active"],
            "neitherTokenText": source_attribution.NEITHER_CHOICE,
            "neitherTokenId": token_ids["neither"],
            "confidenceScalar": source_attribution.CONFIDENCE_SCALAR,
            "frozenThreshold": threshold,
            "allFoldNodesMeasured": True,
            "separateSourcePromptPerFold": True,
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
            **validation_times,
            "executedDecisions": len(validation_trials),
            "meanDecisionSeconds": (
                validation_times["decisionSeconds"] / len(validation_trials)
                if validation_trials else None
            ),
            "meanForwardSeconds": (
                validation_times["forwardSeconds"]
                / validation_times["forwardPasses"]
                if validation_times["forwardPasses"] else None
            ),
            "inputTokensMinimum": min(input_tokens) if input_tokens else None,
            "inputTokensMaximum": max(input_tokens) if input_tokens else None,
            "inputTokensMean": (
                sum(input_tokens) / len(input_tokens) if input_tokens else None
            ),
            "candidateTokensMinimum": (
                min(candidate_tokens) if candidate_tokens else None
            ),
            "candidateTokensMaximum": (
                max(candidate_tokens) if candidate_tokens else None
            ),
            "candidateTokensMean": (
                sum(candidate_tokens) / len(candidate_tokens)
                if candidate_tokens else None
            ),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakReservedBytes": torch.cuda.max_memory_reserved(),
        },
        "inputContract": input_contract,
        "validation": validation,
        "primaryVerdict": {
            "confirmed": validation["confirmed"],
            "rule": (
                "at least four held-out interruptions, every one necessary and aimed "
                "at a relevant fold at frozen threshold 8.625"
            ),
            "thresholdWasRecalibrated": False,
            "developmentWasRescored": False,
            "recallCanPromote": False,
            "latencyCanPromote": False,
        },
        "limitations": [
            "This synthetic held-out split is small and cannot establish production precision.",
            "Changing model family necessarily changes tokenizer ids and native chat-template serialization while semantic message construction stays frozen.",
            "This is constrained-choice likelihood from a local language model, not a claim about raw attention tensors.",
            "Synthetic snapshots represent event boundaries; no Pi event hook is registered.",
            "The fixture supplies one-level expansion projections rather than reading a live fold store.",
            "A parent and descendant can overlap as actions because every standing fold is measured.",
            "Two unrelated GPU processes remained active; timing is contended and nonpromotional.",
            "No carrier, context mutation, active-context fold nomination, or runtime interruption is exercised.",
        ],
        "splits": {"validation": {"trials": validation_trials}},
    }
    return {**stable, "evidenceSha256": attention.stable_sha256(stable)}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Validate Granite source attribution once at frozen threshold 8.625. "
            "The default dry run loads no model and makes no network request."
        )
    )
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="cuda", choices=("cuda",))
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--development", default=str(DEFAULT_DEVELOPMENT))
    parser.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        print(json.dumps(self_test(), indent=2))
        return 0
    fixture_path = Path(args.fixture).expanduser().resolve()
    development_path = Path(args.development).expanduser().resolve()
    refuse(
        fixture_path.is_file(),
        f"attention-source-validation-fixture-missing:{fixture_path}",
    )
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path, development_path)
    else:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "contract": fixture_contract(fixture),
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
        sys.stderr.write(f"Attention source validation failed: {error}\n")
        raise SystemExit(1)
