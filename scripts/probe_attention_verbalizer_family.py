#!/usr/bin/env python3
"""Different-model-family falsifier for the frozen verbalizer-symmetry scorer."""

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
import probe_attention_utility as utility
import probe_attention_verbalizer_symmetry as verbalizer


PROTOCOL_VERSION = 1
SCORER_ID = "granite3.3-per-fold-counterbalanced-verbalizer-v1"
DEFAULT_MODEL = "ibm-granite/granite-3.3-2b-instruct"
EXPECTED_REVISION = "707f574c62054322f6b5b04b6d075f0a8f05e0f0"
EXPECTED_LABEL_TOKEN_IDS = {"A": 399, "B": 551}
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE
DEFAULT_BASELINE = (
    PROJECT
    / "lab"
    / "attention-shadow"
    / "qwen3-1.7b-nf4-verbalizer-symmetry-v1.json"
)
QUANTIZATION = dict(verbalizer.QUANTIZATION)


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = verbalizer.fixture_contract(fixture)
    return {
        **base,
        "scorerId": SCORER_ID,
        "model": DEFAULT_MODEL,
        "choiceTokenIds": dict(EXPECTED_LABEL_TOKEN_IDS),
        "modelFamilyOnlyChange": True,
        "familyComparison": {
            "baselineModel": verbalizer.DEFAULT_MODEL,
            "candidateModel": DEFAULT_MODEL,
            "baselineModelFamily": "Qwen3",
            "candidateModelFamily": "Granite 3.3",
            "baselineEvidenceSha256": (
                "9baffc932baf911dba453c4dd0cc79d1c9060ca958149eeafd111cdd7442fa6c"
            ),
            "frozen": [
                "semantic prompt builder",
                "missing-evidence proposition",
                "A/B mapping reversal",
                "minimum semantic truth bottleneck",
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
                "label token ids",
            ],
        },
        "predecessor": {
            "scorerId": verbalizer.SCORER_ID,
            "policyId": verbalizer.POLICY_ID,
            "model": verbalizer.DEFAULT_MODEL,
            "evidenceSha256": (
                "9baffc932baf911dba453c4dd0cc79d1c9060ca958149eeafd111cdd7442fa6c"
            ),
        },
        "boundary": (
            "offline model-family falsifier only; no semantic prompt rewrite, score "
            "rewrite, threshold rewrite, carrier, Pi event registration, context "
            "mutation, active-context nomination, provider request, generation, "
            "batching, prefilter, cap, truncation, runtime integration, or latency "
            "optimization"
        ),
    }


def label_token_ids(tokenizer: Any) -> dict[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    result = {}
    for name, text in (("A", verbalizer.LABEL_A), ("B", verbalizer.LABEL_B)):
        ids = tokenizer.encode(text, add_special_tokens=False)
        refuse(
            len(ids) == 1 and ids[0] not in special_ids,
            f"attention-family-label-must-be-one-ordinary-token:{name}:{ids}",
        )
        result[name] = int(ids[0])
    refuse(
        result == EXPECTED_LABEL_TOKEN_IDS,
        f"attention-family-label-token-drift:{result}",
    )
    return result


def load_baseline(path: Path) -> dict[str, Any]:
    refuse(path.is_file(), f"attention-family-baseline-missing:{path}")
    baseline = json.loads(path.read_text(encoding="utf-8"))
    refuse(
        baseline.get("scorer", {}).get("id") == verbalizer.SCORER_ID,
        "attention-family-baseline-scorer-drift",
    )
    refuse(
        baseline.get("source", {}).get("scriptSha256")
        == attention.sha256_file(Path(verbalizer.__file__).resolve()),
        "attention-family-frozen-mechanism-source-drift",
    )
    refuse(
        baseline.get("evidenceSha256")
        == "9baffc932baf911dba453c4dd0cc79d1c9060ca958149eeafd111cdd7442fa6c",
        "attention-family-baseline-evidence-drift",
    )
    refuse(
        baseline.get("validation", {}).get("status")
        == "not-run-no-development-threshold"
        and not baseline.get("splits", {}).get("validation", {}).get("trials"),
        "attention-family-baseline-validation-was-opened",
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
        f"attention-family-development-row-count-drift:{len(rows)}",
    )
    mapping_prompts = sum(len(row["mappings"]) for row in rows)
    refuse(
        mapping_prompts == 640
        and all(
            [mapping["mappingId"] for mapping in row["mappings"]]
            == [mapping["id"] for mapping in verbalizer.MAPPINGS]
            for row in rows
        ),
        f"attention-family-mapping-pair-drift:{mapping_prompts}",
    )
    return {"foldRows": len(rows), "mappingPrompts": mapping_prompts}


def self_test() -> dict[str, Any]:
    base = verbalizer.self_test()
    refuse(
        verbalizer.SCORER_ID
        == "qwen3-per-fold-counterbalanced-verbalizer-v1"
        and verbalizer.POLICY_ID
        == "positive-zero-false-counterbalanced-verbalizer-event-v1"
        and verbalizer.CONFIDENCE_SCALAR
        == (
            "maximum per-fold minimum semantic truth margin across reversed A/B mappings"
        ),
        "attention-family-base-contract-drift",
    )
    refuse(
        QUANTIZATION
        == {
            "method": "bitsandbytes-nf4",
            "loadIn4Bit": True,
            "doubleQuant": True,
            "computeDtype": "torch.float16",
            "quantStorage": "torch.uint8",
        },
        "attention-family-quantization-contract-drift",
    )
    return {
        "model": DEFAULT_MODEL,
        "revision": EXPECTED_REVISION,
        "modelFamilyOnlyChange": True,
        "mechanismScorerId": verbalizer.SCORER_ID,
        "policyId": verbalizer.POLICY_ID,
        "labelTokenIds": dict(EXPECTED_LABEL_TOKEN_IDS),
        "fixedLabelPriorMargin": base["fixedLabelPriorMargin"],
        "zeroThresholdRefused": base["zeroThresholdRefused"],
        "quantization": dict(QUANTIZATION),
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

    refuse(args.device == "cuda", "attention-family-requires-cuda")
    refuse(torch.cuda.is_available(), "attention-family-cuda-unavailable")
    refuse(
        args.model == DEFAULT_MODEL,
        f"attention-family-model-is-frozen:{DEFAULT_MODEL}",
    )
    baseline = load_baseline(baseline_path)
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        getattr(config, "_commit_hash", None) == EXPECTED_REVISION,
        f"attention-family-model-revision-drift:{getattr(config, '_commit_hash', None)}",
    )
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-family-needs-fast-tokenizer",
    )
    token_ids = label_token_ids(tokenizer)
    development_prepared = verbalizer.prepare_split(
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
    development_trials, development_times = verbalizer.run_prepared_split(
        torch=torch,
        model=model,
        device=args.device,
        split_name="development",
        prepared=development_prepared,
        token_ids=token_ids,
    )
    development_decisions = [
        verbalizer.decision_row(trial) for trial in development_trials
    ]
    calibration = verbalizer.calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(
        development_decisions,
        verbalizer.MINIMUM_SYMMETRY_THRESHOLD,
    )
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "forwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    if selected is None:
        validation = verbalizer.not_run_validation(fixture)
    elif args.development_only:
        validation = verbalizer.pending_validation(fixture, selected)
    else:
        validation_prepared = verbalizer.prepare_split(
            tokenizer,
            "validation",
            fixture["splits"]["validation"],
            config.max_position_embeddings,
        )
        validation_trials, validation_times = verbalizer.run_prepared_split(
            torch=torch,
            model=model,
            device=args.device,
            split_name="validation",
            prepared=validation_prepared,
            token_ids=token_ids,
        )
        validation_decisions = [
            verbalizer.decision_row(trial) for trial in validation_trials
        ]
        validation = selective.decision_metrics(
            validation_decisions,
            selected["threshold"],
        )
        validation["status"] = "evaluated-with-frozen-threshold"
        validation["confirmed"] = (
            validation["offers"] >= verbalizer.MIN_DEVELOPMENT_OFFERS
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
        "experiment": "frozen counterbalanced-verbalizer model-family falsifier",
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
                Path(verbalizer.__file__).resolve()
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
            "mechanismScorerId": verbalizer.SCORER_ID,
            "policyId": verbalizer.POLICY_ID,
            "labelAText": verbalizer.LABEL_A,
            "labelAId": token_ids["A"],
            "labelBText": verbalizer.LABEL_B,
            "labelBId": token_ids["B"],
            "mappings": [dict(mapping) for mapping in verbalizer.MAPPINGS],
            "confidenceScalar": verbalizer.CONFIDENCE_SCALAR,
            "modelFamilyOnlyChange": True,
            "allFoldNodesMeasured": True,
            "twoReversedMappingPromptsPerFold": True,
            "strictPositiveCounterbalancedMargin": True,
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
        "developmentAtZeroCounterbalancedMargin": zero_threshold,
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
            "Run the frozen counterbalanced-verbalizer scorer with Granite 3.3 2B "
            "Instruct NF4. The default dry run loads no model and makes no network request."
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
        f"attention-family-fixture-missing:{fixture_path}",
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
        sys.stderr.write(f"Attention verbalizer-family probe failed: {error}\n")
        raise SystemExit(1)
