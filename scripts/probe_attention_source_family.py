#!/usr/bin/env python3
"""Granite model-family falsifier for frozen source attribution."""

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
import probe_attention_utility as utility
import probe_attention_verbalizer_family as granite_family


PROTOCOL_VERSION = 1
SCORER_ID = "granite3.3-per-fold-source-attribution-v1"
DEFAULT_MODEL = granite_family.DEFAULT_MODEL
EXPECTED_REVISION = granite_family.EXPECTED_REVISION
EXPECTED_CHOICE_TOKEN_IDS = {
    "candidate": 15133,
    "active": 4523,
    "neither": 25209,
}
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE
DEFAULT_BASELINE = (
    PROJECT
    / "lab"
    / "attention-shadow"
    / "qwen3-1.7b-nf4-source-attribution-v1.json"
)
QUANTIZATION = dict(granite_family.QUANTIZATION)


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = source_attribution.fixture_contract(fixture)
    return {
        **base,
        "scorerId": SCORER_ID,
        "model": DEFAULT_MODEL,
        "choiceTokenIds": dict(EXPECTED_CHOICE_TOKEN_IDS),
        "modelFamilyOnlyChange": True,
        "familyComparison": {
            "baselineModel": source_attribution.DEFAULT_MODEL,
            "candidateModel": DEFAULT_MODEL,
            "baselineModelFamily": "Qwen3",
            "candidateModelFamily": "Granite 3.3",
            "baselineEvidenceSha256": (
                "1b5cdb140a9a96cc1d7dca38b9ad7dc637aee98552f80f01f7a7ff8fc1bc81d9"
            ),
            "frozen": [
                "semantic prompt builder",
                "candidate-active-neither judgment",
                "candidate margin over the stronger alternative",
                "fixture",
                "labels",
                "complete hierarchy",
                "threshold policy",
                "validation lock",
                "NF4 quantization",
            ],
            "changed": [
                "model weights",
                "model family",
                "model architecture",
                "tokenizer",
                "native chat template",
                "choice token ids",
            ],
        },
        "predecessor": {
            "scorerId": source_attribution.SCORER_ID,
            "policyId": source_attribution.POLICY_ID,
            "model": source_attribution.DEFAULT_MODEL,
            "evidenceSha256": (
                "1b5cdb140a9a96cc1d7dca38b9ad7dc637aee98552f80f01f7a7ff8fc1bc81d9"
            ),
        },
        "boundary": (
            "offline model-family falsifier only; no source-label rewrite, semantic "
            "prompt rewrite, score rewrite, threshold rewrite, carrier, Pi event "
            "registration, context mutation, active-context nomination, provider "
            "request, generation, batching, prefilter, cap, truncation, runtime "
            "integration, or latency optimization"
        ),
    }


def choice_token_ids(tokenizer: Any) -> dict[str, int]:
    result = source_attribution.choice_token_ids(tokenizer)
    refuse(
        result == EXPECTED_CHOICE_TOKEN_IDS,
        f"attention-source-family-choice-token-drift:{result}",
    )
    return result


def load_baseline(path: Path) -> dict[str, Any]:
    refuse(path.is_file(), f"attention-source-family-baseline-missing:{path}")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    refuse(
        baseline.get("scorer", {}).get("id") == source_attribution.SCORER_ID,
        "attention-source-family-baseline-scorer-drift",
    )
    refuse(
        baseline.get("source", {}).get("scriptSha256")
        == attention.sha256_file(Path(source_attribution.__file__).resolve()),
        "attention-source-family-frozen-mechanism-source-drift",
    )
    refuse(
        baseline.get("evidenceSha256")
        == "1b5cdb140a9a96cc1d7dca38b9ad7dc637aee98552f80f01f7a7ff8fc1bc81d9",
        "attention-source-family-baseline-evidence-drift",
    )
    refuse(
        baseline.get("validation", {}).get("status")
        == "not-run-no-development-threshold"
        and not baseline.get("splits", {}).get("validation", {}).get("trials"),
        "attention-source-family-baseline-validation-was-opened",
    )
    return baseline


def prepared_contract(prepared: list[dict[str, Any]]) -> dict[str, int]:
    rows = [
        prompt_row["prompt"]
        for item in prepared
        for prompt_row in item["prompts"]
    ]
    refuse(
        len(rows) == 320,
        f"attention-source-family-development-row-count-drift:{len(rows)}",
    )
    return {"foldRows": len(rows), "forwards": len(rows)}


def self_test() -> dict[str, Any]:
    base = source_attribution.self_test()
    refuse(
        source_attribution.SCORER_ID == "qwen3-per-fold-source-attribution-v1"
        and source_attribution.POLICY_ID
        == "positive-zero-false-source-attribution-event-v1"
        and source_attribution.CONFIDENCE_SCALAR
        == (
            "maximum per-fold candidate logit minus the larger of active and "
            "neither logits"
        ),
        "attention-source-family-base-contract-drift",
    )
    return {
        "model": DEFAULT_MODEL,
        "revision": EXPECTED_REVISION,
        "modelFamilyOnlyChange": True,
        "mechanismScorerId": source_attribution.SCORER_ID,
        "policyId": source_attribution.POLICY_ID,
        "choiceTokenIds": dict(EXPECTED_CHOICE_TOKEN_IDS),
        "candidateMargin": base["candidateMargin"],
        "activeMargin": base["activeMargin"],
        "neitherMargin": base["neitherMargin"],
        "zeroThresholdRefused": base["zeroThresholdRefused"],
        "quantization": dict(QUANTIZATION),
    }


def pending_validation(
    fixture: dict[str, Any],
    selected: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": "pending-frozen-development-threshold",
        "eventSnapshots": len(utility.expanded_cases(fixture["splits"]["validation"])),
        "threshold": selected["threshold"],
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

    refuse(args.device == "cuda", "attention-source-family-requires-cuda")
    refuse(torch.cuda.is_available(), "attention-source-family-cuda-unavailable")
    refuse(
        args.model == DEFAULT_MODEL,
        f"attention-source-family-model-is-frozen:{DEFAULT_MODEL}",
    )
    baseline = load_baseline(baseline_path)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        getattr(config, "_commit_hash", None) == EXPECTED_REVISION,
        f"attention-source-family-model-revision-drift:"
        f"{getattr(config, '_commit_hash', None)}",
    )
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-source-family-needs-fast-tokenizer",
    )
    token_ids = choice_token_ids(tokenizer)
    development_prepared = source_attribution.prepare_split(
        tokenizer,
        "development",
        fixture["splits"]["development"],
        config.max_position_embeddings,
    )
    input_contract = prepared_contract(development_prepared)
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
    development_trials, development_times = source_attribution.run_prepared_split(
        torch=torch,
        model=model,
        device=args.device,
        split_name="development",
        prepared=development_prepared,
        token_ids=token_ids,
    )
    development_decisions = [
        source_attribution.decision_row(trial) for trial in development_trials
    ]
    calibration = source_attribution.calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(
        development_decisions,
        source_attribution.MINIMUM_ATTRIBUTION_THRESHOLD,
    )
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "forwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    if selected is None:
        validation = source_attribution.not_run_validation(fixture)
    elif args.development_only:
        validation = pending_validation(fixture, selected)
    else:
        validation_prepared = source_attribution.prepare_split(
            tokenizer,
            "validation",
            fixture["splits"]["validation"],
            config.max_position_embeddings,
        )
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
        validation = selective.decision_metrics(
            validation_decisions,
            selected["threshold"],
        )
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= source_attribution.MIN_DEVELOPMENT_OFFERS
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
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "frozen source-attribution model-family falsifier",
        "contract": fixture_contract(fixture),
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
            "inputContract": input_contract,
        },
        "source": {
            "scriptSha256": attention.sha256_file(Path(__file__).resolve()),
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
            "mechanismScorerId": source_attribution.SCORER_ID,
            "policyId": source_attribution.POLICY_ID,
            "candidateTokenText": source_attribution.CANDIDATE_CHOICE,
            "candidateTokenId": token_ids["candidate"],
            "activeTokenText": source_attribution.ACTIVE_CHOICE,
            "activeTokenId": token_ids["active"],
            "neitherTokenText": source_attribution.NEITHER_CHOICE,
            "neitherTokenId": token_ids["neither"],
            "confidenceScalar": source_attribution.CONFIDENCE_SCALAR,
            "modelFamilyOnlyChange": True,
            "allFoldNodesMeasured": True,
            "separateSourcePromptPerFold": True,
            "strictPositiveCandidateMargin": True,
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
                total_times["forwardSeconds"] / total_times["forwardPasses"]
                if total_times["forwardPasses"] else None
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
        "developmentAtZeroCandidateMargin": zero_threshold,
        "calibration": calibration,
        "validation": validation,
        "primaryVerdict": {
            "confirmed": bool(validation.get("confirmed")),
            "rule": (
                "at least four held-out interruptions, every one necessary and aimed "
                "at a relevant fold"
            ),
            "recallCanPromote": False,
            "latencyCanPromote": False,
        },
        "limitations": [
            "Changing model family necessarily changes tokenizer ids and native chat-template serialization while semantic message construction stays frozen.",
            "This is constrained-choice likelihood from a local language model, not a claim about raw attention tensors.",
            "Synthetic snapshots represent event boundaries; no Pi event hook is registered.",
            "The fixture supplies one-level expansion projections rather than reading a live fold store.",
            "A parent and descendant can overlap as actions because every standing fold is measured.",
            "Four offers prevent a singleton pass but cannot establish production precision.",
            "Two unrelated GPU processes remained active; timing is contended and nonpromotional.",
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
            "Run the frozen source-attribution scorer with Granite 3.3 2B Instruct "
            "NF4. The default dry run loads no model and makes no network request."
        )
    )
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--development-only", action="store_true")
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
        f"attention-source-family-fixture-missing:{fixture_path}",
    )
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path, baseline_path)
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
        sys.stderr.write(f"Attention source-family probe failed: {error}\n")
        raise SystemExit(1)
