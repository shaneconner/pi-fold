#!/usr/bin/env python3
"""Precision-first per-fold missing-evidence proposition probe."""

from __future__ import annotations

import argparse
import json
import math
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


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-per-fold-missing-evidence-proposition-v1"
POLICY_ID = "positive-zero-false-missing-evidence-event-v1"
CONFIDENCE_SCALAR = "maximum per-fold true logit minus false logit"
TRUE_CHOICE = " true"
FALSE_CHOICE = " false"
DEVELOPMENT_REQUIRED_PRECISION = 1.0
MIN_DEVELOPMENT_OFFERS = 4
MINIMUM_PROPOSITION_THRESHOLD = 0.0
DEFAULT_MODEL = capacity.DEFAULT_MODEL
QUANTIZATION = dict(capacity.QUANTIZATION)
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = utility.DEFAULT_FIXTURE


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def fixture_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    base = source_attribution.fixture_contract(fixture)
    base.pop("judgment", None)
    base.pop("score", None)
    return {
        **base,
        "scorerId": SCORER_ID,
        "policyId": POLICY_ID,
        "confidenceScalar": CONFIDENCE_SCALAR,
        "interruptWhen": (
            "the largest strictly positive missing-evidence truth margin meets or exceeds "
            "the frozen threshold"
        ),
        "candidateAction": (
            "expand exactly the fold with the largest missing-evidence truth margin"
        ),
        "choiceTokens": [TRUE_CHOICE, FALSE_CHOICE],
        "proposition": (
            "this exact fold supplies every piece of stated evidence missing from active "
            "context that is needed to answer the current task correctly and completely"
        ),
        "falseWhen": [
            "active context already suffices",
            "the fold is merely related or partial",
            "the fold does not answer the task",
            "the task can be performed from the active instruction alone",
        ],
        "score": "true logit minus false logit for each complete fold",
        "jointCorrectOffer": (
            "the winning fold has a strictly positive true-minus-false margin and is the "
            "exact fold that supplies missing evidence"
        ),
        "calibration": {
            "source": "development only",
            "requiredObservedPrecision": DEVELOPMENT_REQUIRED_PRECISION,
            "minimumOffers": MIN_DEVELOPMENT_OFFERS,
            "minimumThreshold": MINIMUM_PROPOSITION_THRESHOLD,
            "thresholdIsStrictlyPositive": True,
            "selection": (
                "lowest positive truth-margin threshold with zero false offers and the most "
                "offers"
            ),
        },
        "model": DEFAULT_MODEL,
        "quantization": dict(QUANTIZATION),
        "boundary": (
            "offline constrained-choice missing-evidence experiment only; no attention-tensor "
            "claim, three-way source score, carrier, Pi event registration, context mutation, "
            "active-context nomination, provider request, generation, batching, prefilter, cap, "
            "truncation, runtime integration, or latency optimization"
        ),
    }


def choice_token_ids(tokenizer: Any) -> dict[str, int]:
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    result = {}
    for name, text in (("true", TRUE_CHOICE), ("false", FALSE_CHOICE)):
        ids = tokenizer.encode(text, add_special_tokens=False)
        refuse(
            len(ids) == 1 and ids[0] not in special_ids,
            f"attention-missing-choice-must-be-one-ordinary-token:{name}:{ids}",
        )
        result[name] = int(ids[0])
    refuse(
        result["true"] != result["false"],
        "attention-missing-choice-token-collision",
    )
    return result


def build_prompt_text(
    tokenizer: Any,
    fold: dict[str, Any],
    case: dict[str, Any],
) -> str:
    system = (
        "Act as a strict evidence proposition judge. Evaluate only the stated proposition. "
        "It is true only when active context alone is insufficient for the current task and "
        "the candidate fold supplies every missing stated fact needed to answer correctly and "
        "completely. It is false when active context already suffices, the task can be performed "
        "from the active instruction, the candidate is merely related or partial, or the "
        "candidate does not answer the task. Do not infer unstated facts. False true judgments "
        "are worse than missed true judgments. Reply with exactly true or false."
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
        "</CANDIDATE_FOLD>\n\n<PROPOSITION>\n"
        "This exact candidate fold supplies every piece of stated evidence missing from active "
        "context that is needed to answer the current task correctly and completely.\n"
        "</PROPOSITION>\n\nIs the proposition true or false?"
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
    refuse(
        rendered.count(fold["expandedContent"]) == 1,
        f"attention-missing-chat-template-candidate-count:{fold['foldId']}",
    )
    refuse(
        rendered.count(case["activeContext"]) == 1
        and rendered.count(case["task"]) == 1,
        f"attention-missing-chat-template-context-count:{case['id']}:{fold['foldId']}",
    )
    return rendered + "Verdict:"


def prepare_fold_prompt(
    tokenizer: Any,
    fold: dict[str, Any],
    case: dict[str, Any],
) -> dict[str, Any]:
    prompt = build_prompt_text(tokenizer, fold, case)
    encoded = tokenizer(
        prompt,
        add_special_tokens=False,
        truncation=False,
        return_tensors="pt",
    )
    candidate_ids = tokenizer.encode(
        fold["expandedContent"],
        add_special_tokens=False,
    )
    refuse(
        bool(candidate_ids),
        f"attention-missing-empty-candidate-token-span:{fold['foldId']}",
    )
    input_ids = encoded["input_ids"][0].tolist()
    return {
        "encoded": encoded,
        "promptSha256": attention.sha256_text(prompt),
        "inputSha256": attention.sha256_text(
            json.dumps(input_ids, separators=(",", ":"))
        ),
        "inputTokens": len(input_ids),
        "candidateTokens": len(candidate_ids),
        "candidateChars": len(fold["expandedContent"]),
        "candidateContentSha256": attention.sha256_text(fold["expandedContent"]),
    }


def proposition_values(true_logit: float, false_logit: float) -> dict[str, Any]:
    margin = true_logit - false_logit
    if margin >= 0:
        probability = 1.0 / (1.0 + math.exp(-margin))
    else:
        exp_margin = math.exp(margin)
        probability = exp_margin / (1.0 + exp_margin)
    return {
        "trueLogit": true_logit,
        "falseLogit": false_logit,
        "truthMargin": margin,
        "trueProbabilityWithinChoices": probability,
        "unthresholdedChoice": "true" if margin >= 0 else "false",
    }


def score_once(
    torch: Any,
    model: Any,
    encoded: dict[str, Any],
    device: str,
    token_ids: dict[str, int],
) -> tuple[dict[str, Any], float]:
    device_encoded = {key: value.to(device) for key, value in encoded.items()}
    torch.cuda.synchronize()
    started = time.perf_counter()
    with torch.inference_mode():
        outputs = model(
            **device_encoded,
            use_cache=False,
            output_attentions=False,
            return_dict=True,
        )
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    logits = outputs.logits[0, -1].float()
    values = proposition_values(
        float(logits[token_ids["true"]].item()),
        float(logits[token_ids["false"]].item()),
    )
    del logits, outputs, device_encoded
    return values, elapsed


def ranked_folds(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(rows, key=lambda row: (-row["truthMargin"], row["id"]))
    return [{**row, "rank": rank} for rank, row in enumerate(ranked, start=1)]


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
                f"attention-missing-input-exceeds-model-context:{split_name}:"
                f"{case['id']}:{fold_id}:{prompt['inputTokens']}:{context_tokens}",
            )
            prompts.append({"foldId": fold_id, "prompt": prompt})
        refuse(
            len(prompts) == len(fold_ids)
            and {row["foldId"] for row in prompts} == set(fold_ids),
            f"attention-missing-did-not-measure-every-fold:{split_name}:{case['id']}",
        )
        prepared.append({"case": case, "order": order, "prompts": prompts})
    return prepared


def expected_truth(case: dict[str, Any], fold_id: str) -> bool:
    return case["class"] == "positive" and fold_id == case["themeFoldId"]


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
        "forwardSeconds": 0.0,
        "decisionSeconds": 0.0,
        "forwardPasses": 0,
    }
    for index, item in enumerate(prepared, start=1):
        decision_started = time.perf_counter()
        case = item["case"]
        folds = []
        for prompt_row in item["prompts"]:
            prompt = prompt_row["prompt"]
            values, forward_seconds = score_once(
                torch,
                model,
                prompt["encoded"],
                device,
                token_ids,
            )
            totals["forwardSeconds"] += forward_seconds
            totals["forwardPasses"] += 1
            folds.append({
                "id": prompt_row["foldId"],
                "promptSha256": prompt["promptSha256"],
                "inputSha256": prompt["inputSha256"],
                "inputTokens": prompt["inputTokens"],
                "candidateTokens": prompt["candidateTokens"],
                "candidateChars": prompt["candidateChars"],
                "candidateContentSha256": prompt["candidateContentSha256"],
                "forwardSeconds": forward_seconds,
                **values,
                "expectedTruth": expected_truth(case, prompt_row["foldId"]),
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
            "winnerTruthMargin": winner["truthMargin"],
            "winnerUnthresholdedChoice": winner["unthresholdedChoice"],
            "decisionSeconds": decision_seconds,
            "folds": ranked,
        })
        if index % 4 == 0 or index == len(prepared):
            print(
                f"attention missing evidence {split_name}: "
                f"{index}/{len(prepared)} events",
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
        "confidence": winner["truthMargin"],
        "correct": trial["class"] == "positive" and winner["id"] in relevant,
        "opportunity": trial["class"] == "positive",
    }


def calibrate_threshold(decisions: list[dict[str, Any]]) -> dict[str, Any]:
    sweep = selective.threshold_sweep(decisions)
    eligible = [
        point for point in sweep
        if point["threshold"] > MINIMUM_PROPOSITION_THRESHOLD
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
        "minimumThreshold": MINIMUM_PROPOSITION_THRESHOLD,
        "thresholdIsStrictlyPositive": True,
        "selected": selected,
        "eligiblePoints": len(eligible),
        "sweep": sweep,
    }


def self_test() -> dict[str, Any]:
    true_case = proposition_values(5.0, 2.0)
    false_case = proposition_values(1.0, 4.0)
    refuse(
        true_case["truthMargin"] == 3.0
        and true_case["unthresholdedChoice"] == "true"
        and false_case["truthMargin"] == -3.0
        and false_case["unthresholdedChoice"] == "false",
        "attention-missing-margin-self-test-failed",
    )
    ranked = ranked_folds([
        {"id": "z-fold", "truthMargin": 0.8},
        {"id": "a-fold", "truthMargin": 0.8},
        {"id": "low-fold", "truthMargin": -0.4},
    ])
    refuse(
        [row["id"] for row in ranked] == ["a-fold", "z-fold", "low-fold"],
        "attention-missing-deterministic-ranking-self-test-failed",
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
        "attention-missing-calibration-self-test-failed",
    )
    zero_only = [{**row, "confidence": 0.0} for row in decisions[:4]]
    refuse(
        calibrate_threshold(zero_only)["selected"] is None,
        "attention-missing-zero-threshold-self-test-failed",
    )
    fixture_case = {"themeFoldId": "right", "class": "positive"}
    refuse(
        expected_truth(fixture_case, "right") is True
        and expected_truth(fixture_case, "wrong") is False
        and expected_truth({"themeFoldId": "x", "class": "already-visible"}, "x")
        is False,
        "attention-missing-expected-truth-self-test-failed",
    )
    wrong_fold_trial = {
        "caseId": "wrong-fold",
        "class": "positive",
        "eventKind": "stop",
        "relevantFoldIds": ["right"],
        "folds": [
            {"id": "wrong", "truthMargin": 4.0, "rank": 1},
            {"id": "right", "truthMargin": 3.0, "rank": 2},
        ],
    }
    refuse(
        decision_row(wrong_fold_trial)["correct"] is False,
        "attention-missing-wrong-fold-self-test-failed",
    )
    return {
        "trueMargin": true_case["truthMargin"],
        "trueChoice": true_case["unthresholdedChoice"],
        "falseMargin": false_case["truthMargin"],
        "falseChoice": false_case["unthresholdedChoice"],
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
    import bitsandbytes
    import torch
    import transformers
    from transformers import (
        AutoConfig,
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
    )

    refuse(args.device == "cuda", "attention-missing-requires-cuda")
    refuse(torch.cuda.is_available(), "attention-missing-cuda-unavailable")
    refuse(
        args.model == DEFAULT_MODEL,
        f"attention-missing-model-is-frozen:{DEFAULT_MODEL}",
    )
    torch.cuda.reset_peak_memory_stats()
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(
        bool(getattr(tokenizer, "is_fast", False)),
        "attention-missing-needs-fast-tokenizer",
    )
    token_ids = choice_token_ids(tokenizer)
    development_prepared = prepare_split(
        tokenizer,
        "development",
        fixture["splits"]["development"],
        config.max_position_embeddings,
    )
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
        "deviceMap": capacity.model_device_map(model),
        "generatedTokens": 0,
    }
    load_finished = time.perf_counter()
    development_trials, development_times = run_prepared_split(
        torch=torch,
        model=model,
        device=args.device,
        split_name="development",
        prepared=development_prepared,
        token_ids=token_ids,
    )
    development_decisions = [decision_row(trial) for trial in development_trials]
    calibration = calibrate_threshold(development_decisions)
    selected = calibration["selected"]
    zero_threshold = selective.decision_metrics(
        development_decisions,
        MINIMUM_PROPOSITION_THRESHOLD,
    )
    validation_trials = []
    validation_times: dict[str, float | int] = {
        "forwardSeconds": 0.0,
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
            torch=torch,
            model=model,
            device=args.device,
            split_name="validation",
            prepared=validation_prepared,
            token_ids=token_ids,
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
    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "per-fold missing-evidence binary proposition",
        "contract": fixture_contract(fixture),
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
            "modelLoaderScriptSha256": attention.sha256_file(
                Path(capacity.__file__).resolve()
            ),
        },
        "model": model_metadata,
        "scorer": {
            "id": SCORER_ID,
            "policyId": POLICY_ID,
            "trueTokenText": TRUE_CHOICE,
            "trueTokenId": token_ids["true"],
            "falseTokenText": FALSE_CHOICE,
            "falseTokenId": token_ids["false"],
            "confidenceScalar": CONFIDENCE_SCALAR,
            "allFoldNodesMeasured": True,
            "separatePropositionPromptPerFold": True,
            "strictPositiveTruthMargin": True,
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
            "candidateTokensMinimum": min(candidate_tokens) if candidate_tokens else None,
            "candidateTokensMaximum": max(candidate_tokens) if candidate_tokens else None,
            "candidateTokensMean": (
                sum(candidate_tokens) / len(candidate_tokens)
                if candidate_tokens else None
            ),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakReservedBytes": torch.cuda.max_memory_reserved(),
        },
        "developmentAtZeroTruthMargin": zero_threshold,
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
            "Run a binary missing-evidence proposition with Qwen3-1.7B NF4. The default "
            "dry run loads no model and makes no network request."
        )
    )
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="cuda", choices=("cuda",))
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
        f"attention-missing-fixture-missing:{fixture_path}",
    )
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path)
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
        sys.stderr.write(f"Attention missing-evidence probe failed: {error}\n")
        raise SystemExit(1)
