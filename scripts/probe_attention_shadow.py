#!/usr/bin/env python3
"""Forward-only local attention probe over complete supplied candidates.

Protocol 1 is deliberately narrow. It proves whether a small local causal
language model exposes a query-responsive attention signal. It does not emit a
carrier, choose a threshold, mutate pi-fold state, or nominate active context
for folding. Every supplied candidate is placed in each prompt. Inputs that do
not fit the model are refused rather than shortened or silently omitted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import sys
import time
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-readout-attention-density-v1"
DEFAULT_MODEL = "Qwen/Qwen3-0.6B"
READOUT_CUE = "Evidence needed for this query is located in candidate"
PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = PROJECT / "scripts" / "fixtures" / "attention_shadow_v1.json"
OUTPUT_ROOT = PROJECT / "lab" / "attention-shadow"


def refuse(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(encoded)


def load_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    refuse(fixture.get("protocolVersion") == PROTOCOL_VERSION,
           "attention-shadow-fixture-version-mismatch")
    candidates = fixture.get("candidates")
    cases = fixture.get("cases")
    refuse(isinstance(candidates, list) and len(candidates) >= 2,
           "attention-shadow-needs-at-least-two-candidates")
    refuse(isinstance(cases, list) and cases, "attention-shadow-needs-query-cases")
    ids = [candidate.get("id") for candidate in candidates]
    refuse(all(isinstance(candidate_id, str) and candidate_id for candidate_id in ids),
           "attention-shadow-candidate-needs-id")
    refuse(len(set(ids)) == len(ids), "attention-shadow-candidate-ids-must-be-unique")
    refuse(all(isinstance(candidate.get("content"), str) and candidate["content"].strip()
               for candidate in candidates),
           "attention-shadow-candidate-needs-complete-content")
    for case in cases:
        refuse(isinstance(case.get("id"), str) and case["id"],
               "attention-shadow-case-needs-id")
        refuse(isinstance(case.get("query"), str) and case["query"].strip(),
               f"attention-shadow-case-needs-query:{case.get('id')}")
        relevant = case.get("relevantCandidateIds")
        refuse(isinstance(relevant, list) and relevant,
               f"attention-shadow-case-needs-label:{case.get('id')}")
        refuse(all(candidate_id in ids for candidate_id in relevant),
               f"attention-shadow-label-names-missing-candidate:{case.get('id')}")
    return fixture


def rotations(candidate_ids: list[str]) -> list[list[str]]:
    return [candidate_ids[offset:] + candidate_ids[:offset]
            for offset in range(len(candidate_ids))]


def prompt_contract(fixture: dict[str, Any]) -> dict[str, Any]:
    candidate_ids = [candidate["id"] for candidate in fixture["candidates"]]
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "scorerId": SCORER_ID,
        "model": DEFAULT_MODEL,
        "fixtureId": fixture.get("fixtureId"),
        "candidateCount": len(candidate_ids),
        "queryCases": len(fixture["cases"]),
        "ordersPerCase": len(candidate_ids),
        "forwardPasses": len(candidate_ids) * len(fixture["cases"]),
        "candidateOrders": rotations(candidate_ids),
        "candidateSelection": "all supplied candidates in every forward pass",
        "candidateContent": "complete supplied content",
        "inputTruncation": False,
        "prefilter": None,
        "generationCalls": 0,
        "providerCalls": 0,
        "primaryScore": (
            "mean attention per candidate token over every head and the final quarter "
            "of layers, read from every token in a fixed teacher-forced readout cue"
        ),
        "primaryDirection": "higher-is-more-relevant",
        "labelsVisibleToScorer": False,
        "boundary": (
            "experiment only; no carrier, threshold, runtime mutation, or active-context "
            "fold nomination"
        ),
    }


def append_segment(parts: list[str], text: str) -> tuple[int, int]:
    start = sum(len(part) for part in parts)
    parts.append(text)
    return start, start + len(text)


def build_user_prompt(candidates_by_id: dict[str, dict[str, Any]], order: list[str],
                      query: str) -> tuple[str, dict[str, tuple[int, int]]]:
    parts: list[str] = []
    append_segment(parts,
                   "Read every complete evidence candidate below. Candidate identifiers are "
                   "arbitrary and their order carries no meaning. Use the query only to decide "
                   "which evidence would be useful.\n")
    spans: dict[str, tuple[int, int]] = {}
    for candidate_id in order:
        candidate = candidates_by_id[candidate_id]
        append_segment(parts, f'\n<CANDIDATE id="{candidate_id}">\n')
        spans[candidate_id] = append_segment(parts, candidate["content"])
        append_segment(parts, "\n</CANDIDATE>\n")
    append_segment(parts, "\n<QUERY>\n")
    append_segment(parts, query)
    append_segment(parts,
                   "\n</QUERY>\nDo not answer the query. Prepare to identify the single candidate "
                   "whose evidence is most useful.\n")
    return "".join(parts), spans


def overlapping_token_positions(offsets: list[tuple[int, int]], start: int,
                                end: int) -> list[int]:
    return [index for index, (token_start, token_end) in enumerate(offsets)
            if token_end > start and token_start < end]


def prepare_prompt(tokenizer: Any, candidates_by_id: dict[str, dict[str, Any]],
                   order: list[str], query: str) -> dict[str, Any]:
    user_text, user_spans = build_user_prompt(candidates_by_id, order, query)
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": user_text}],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    user_start = rendered.find(user_text)
    refuse(user_start >= 0, "attention-shadow-chat-template-lost-user-content")
    cue_start = len(rendered)
    full_prompt = rendered + READOUT_CUE
    encoded = tokenizer(
        full_prompt,
        add_special_tokens=False,
        truncation=False,
        return_offsets_mapping=True,
        return_tensors="pt",
    )
    offsets = [tuple(pair) for pair in encoded.pop("offset_mapping")[0].tolist()]
    candidate_tokens: dict[str, list[int]] = {}
    for candidate_id, (start, end) in user_spans.items():
        positions = overlapping_token_positions(offsets, user_start + start, user_start + end)
        refuse(bool(positions), f"attention-shadow-empty-token-span:{candidate_id}")
        candidate_tokens[candidate_id] = positions
    probe_tokens = overlapping_token_positions(offsets, cue_start, len(full_prompt))
    refuse(bool(probe_tokens), "attention-shadow-empty-readout-token-span")
    covered = [position for positions in candidate_tokens.values() for position in positions]
    refuse(len(covered) == len(set(covered)), "attention-shadow-overlapping-candidate-spans")
    return {
        "encoded": encoded,
        "promptSha256": sha256_text(full_prompt),
        "promptCharacters": len(full_prompt),
        "inputTokens": int(encoded["input_ids"].shape[1]),
        "candidateTokens": candidate_tokens,
        "probeTokens": probe_tokens,
    }


def rank_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: (-row["attentionDensity"], row["id"]))
    ranks = {row["id"]: index + 1 for index, row in enumerate(ordered)}
    density_total = sum(row["attentionDensity"] for row in rows)
    mass_total = sum(row["attentionMass"] for row in rows)
    return [
        {
            **row,
            "densityShare": row["attentionDensity"] / density_total if density_total else 0.0,
            "massShare": row["attentionMass"] / mass_total if mass_total else 0.0,
            "rank": ranks[row["id"]],
        }
        for row in sorted(rows, key=lambda row: row["id"])
    ]


def score_attentions(attentions: tuple[Any, ...], candidate_tokens: dict[str, list[int]],
                     probe_tokens: list[int]) -> tuple[list[dict[str, Any]], list[int]]:
    refuse(bool(attentions), "attention-shadow-model-returned-no-attentions")
    layer_count = len(attentions)
    first_layer = (layer_count * 3) // 4
    selected_layers = list(range(first_layer, layer_count))
    refuse(bool(selected_layers), "attention-shadow-selected-no-layers")
    rows = []
    for candidate_id, token_positions in candidate_tokens.items():
        layer_densities = []
        layer_masses = []
        for layer_index in selected_layers:
            layer = attentions[layer_index]
            refuse(layer is not None and layer.ndim == 4,
                   f"attention-shadow-incomplete-attention-layer:{layer_index}")
            view = layer[0, :, probe_tokens, :][:, :, token_positions].float()
            layer_densities.append(float(view.mean().item()))
            layer_masses.append(float(view.sum(dim=-1).mean().item()))
        rows.append({
            "id": candidate_id,
            "tokenCount": len(token_positions),
            "attentionDensity": sum(layer_densities) / len(layer_densities),
            "attentionMass": sum(layer_masses) / len(layer_masses),
            "layerDensityMinimum": min(layer_densities),
            "layerDensityMaximum": max(layer_densities),
        })
    return rank_rows(rows), selected_layers


def exact_binomial_upper_tail(successes: int, trials: int, probability: float) -> float:
    return sum(math.comb(trials, count) * probability ** count *
               (1.0 - probability) ** (trials - count)
               for count in range(successes, trials + 1))


def summarize(trials: list[dict[str, Any]], fixture: dict[str, Any]) -> dict[str, Any]:
    candidate_count = len(fixture["candidates"])
    expected_trials = candidate_count * len(fixture["cases"])
    refuse(len(trials) == expected_trials, "attention-shadow-missing-forward-pass")
    expected_rows = expected_trials * candidate_count
    actual_rows = sum(len(trial["candidates"]) for trial in trials)
    refuse(actual_rows == expected_rows, "attention-shadow-omitted-candidate-row")
    hit_at_1 = 0
    reciprocal_ranks = []
    cases = []
    for case in fixture["cases"]:
        case_trials = [trial for trial in trials if trial["caseId"] == case["id"]]
        target_ranks = []
        target_scores = []
        for trial in case_trials:
            relevant_rows = [row for row in trial["candidates"] if row["relevant"]]
            refuse(bool(relevant_rows), f"attention-shadow-label-join-failed:{case['id']}")
            best_rank = min(row["rank"] for row in relevant_rows)
            target_ranks.append(best_rank)
            target_scores.append(max(row["densityShare"] for row in relevant_rows))
            hit_at_1 += int(best_rank == 1)
            reciprocal_ranks.append(1.0 / best_rank)
        cases.append({
            "id": case["id"],
            "targetRanksByRotation": target_ranks,
            "hitAt1": sum(rank == 1 for rank in target_ranks),
            "meanTargetDensityShare": sum(target_scores) / len(target_scores),
            "minimumTargetDensityShare": min(target_scores),
            "maximumTargetDensityShare": max(target_scores),
        })
    first_hits = sum(
        min(trial["candidates"], key=lambda row: row["rank"])["id"] == trial["order"][0]
        for trial in trials
    )
    newest_hits = sum(
        min(trial["candidates"], key=lambda row: row["rank"])["id"] == trial["order"][-1]
        for trial in trials
    )
    return {
        "trials": len(trials),
        "candidateRows": actual_rows,
        "allCandidatesScored": True,
        "hitAt1": hit_at_1,
        "hitAt1Rate": hit_at_1 / len(trials),
        "chanceHitAt1Rate": 1.0 / candidate_count,
        "exactBinomialUpperTailAgainstUniformChance": exact_binomial_upper_tail(
            hit_at_1, len(trials), 1.0 / candidate_count),
        "meanReciprocalRank": sum(reciprocal_ranks) / len(reciprocal_ranks),
        "topRankWasFirstCandidate": first_hits,
        "topRankWasFirstCandidateRate": first_hits / len(trials),
        "topRankWasNearestCandidate": newest_hits,
        "topRankWasNearestCandidateRate": newest_hits / len(trials),
        "cases": cases,
    }


def environment_report(torch: Any, device: str) -> dict[str, Any]:
    report = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "torch": torch.__version__,
        "device": device,
    }
    if device == "cuda":
        properties = torch.cuda.get_device_properties(0)
        report.update({
            "cuda": torch.version.cuda,
            "gpu": properties.name,
            "gpuMemoryBytes": properties.total_memory,
            "computeCapability": f"{properties.major}.{properties.minor}",
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakReservedBytes": torch.cuda.max_memory_reserved(),
        })
    return report


def run_live(args: argparse.Namespace, fixture: dict[str, Any],
             fixture_path: Path) -> dict[str, Any]:
    import torch
    import transformers
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(args.device in {"cuda", "cpu"}, "attention-shadow-device-must-be-cuda-or-cpu")
    if args.device == "cuda":
        refuse(torch.cuda.is_available(), "attention-shadow-cuda-unavailable")
        dtype = torch.float16
        torch.cuda.reset_peak_memory_stats()
    else:
        dtype = torch.float32

    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(tokenizer, "is_fast", False), "attention-shadow-needs-fast-tokenizer-offsets")
    candidates_by_id = {candidate["id"]: candidate for candidate in fixture["candidates"]}
    candidate_ids = list(candidates_by_id)
    prepared = []
    for case in fixture["cases"]:
        for rotation_index, order in enumerate(rotations(candidate_ids)):
            prompt = prepare_prompt(tokenizer, candidates_by_id, order, case["query"])
            refuse(prompt["inputTokens"] <= config.max_position_embeddings,
                   f"attention-shadow-input-exceeds-model-context:{case['id']}:"
                   f"{prompt['inputTokens']}:{config.max_position_embeddings}")
            prepared.append((case, rotation_index, order, prompt))

    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        dtype=dtype,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).to(args.device).eval()
    load_finished = time.perf_counter()
    model_layers = int(getattr(model.config, "num_hidden_layers", 0))
    refuse(model_layers > 0, "attention-shadow-model-has-no-declared-layers")
    trials = []
    selected_layers: list[int] | None = None
    forward_seconds = 0.0
    for case, rotation_index, order, prompt in prepared:
        encoded = {key: value.to(args.device) for key, value in prompt["encoded"].items()}
        if args.device == "cuda":
            torch.cuda.synchronize()
        forward_started = time.perf_counter()
        with torch.inference_mode():
            outputs = model(
                **encoded,
                use_cache=False,
                output_attentions=True,
                return_dict=True,
            )
        if args.device == "cuda":
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - forward_started
        forward_seconds += elapsed
        attentions = outputs.attentions
        refuse(attentions is not None and len(attentions) == model_layers,
               f"attention-shadow-incomplete-attention-stack:"
               f"{0 if attentions is None else len(attentions)}:{model_layers}")
        score_rows, trial_layers = score_attentions(
            attentions, prompt["candidateTokens"], prompt["probeTokens"])
        if selected_layers is None:
            selected_layers = trial_layers
        else:
            refuse(selected_layers == trial_layers, "attention-shadow-layer-selection-drift")
        relevant_ids = set(case["relevantCandidateIds"])
        trials.append({
            "caseId": case["id"],
            "rotation": rotation_index,
            "order": order,
            "querySha256": sha256_text(case["query"]),
            "promptSha256": prompt["promptSha256"],
            "promptCharacters": prompt["promptCharacters"],
            "inputTokens": prompt["inputTokens"],
            "readoutTokens": len(prompt["probeTokens"]),
            "forwardSeconds": elapsed,
            "candidates": [
                {**row, "relevant": row["id"] in relevant_ids}
                for row in score_rows
            ],
        })
        del attentions, outputs, encoded

    stable = {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "forward-only complete-candidate local attention shadow",
        "contract": {**prompt_contract(fixture), "model": args.model},
        "fixture": {
            "path": str(fixture_path.relative_to(PROJECT)),
            "sha256": sha256_file(fixture_path),
            "id": fixture.get("fixtureId"),
            "description": fixture.get("description"),
        },
        "source": {
            "scriptSha256": sha256_file(Path(__file__).resolve()),
        },
        "model": {
            "id": args.model,
            "revision": getattr(config, "_commit_hash", None),
            "architecture": list(getattr(config, "architectures", []) or []),
            "parametersDtype": str(next(model.parameters()).dtype),
            "layers": model_layers,
            "attentionHeads": int(getattr(config, "num_attention_heads", 0)),
            "contextTokens": int(config.max_position_embeddings),
            "attentionImplementation": "eager",
            "selectedLayerIndices": selected_layers,
            "selectedLayerRule": "final quarter, starting at floor(three quarters of layer count)",
            "quantized": False,
            "generatedTokens": 0,
        },
        "runtime": {
            **environment_report(torch, args.device),
            "transformers": transformers.__version__,
            "offline": args.offline,
            "loadSeconds": load_finished - load_started,
            "forwardSeconds": forward_seconds,
            "meanForwardSeconds": forward_seconds / len(trials),
        },
        "summary": summarize(trials, fixture),
        "limitations": [
            "Attention density is an internal association proxy, not a causal importance proof.",
            "This controlled fixture is not a threshold calibration or a sealed-session retrieval verdict.",
            "Whole candidates share one prompt; protocol 1 refuses model-context overflow instead of chunking or shortening content.",
            "Only folded-context retrieval is tested; active-context fold nomination belongs to a later build.",
            "No suggestion carrier is emitted and no pi-fold runtime behavior changes.",
        ],
        "trials": trials,
    }
    return {**stable, "evidenceSha256": stable_sha256(stable)}


def safe_output_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser().resolve()
    root = OUTPUT_ROOT.resolve()
    refuse(path == root or root in path.parents,
           f"attention-shadow-output-must-stay-under:{root}")
    refuse(path != root, "attention-shadow-output-needs-file-path")
    return path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure forward-only local model attention over every complete supplied candidate. "
            "The default dry run makes no model, provider, or network calls."
        )
    )
    parser.add_argument("--live", action="store_true", help="load the model and run the probe")
    parser.add_argument("--offline", action="store_true",
                        help="require model files to exist in the local Hugging Face cache")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help="Hugging Face model id or local model directory")
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    parser.add_argument("--output", help="JSON path under lab/attention-shadow")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    fixture_path = Path(args.fixture).expanduser().resolve()
    refuse(fixture_path.is_file(), f"attention-shadow-fixture-missing:{fixture_path}")
    fixture = load_fixture(fixture_path)
    if not args.live:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "contract": {**prompt_contract(fixture), "model": args.model},
            "fixtureSha256": sha256_file(fixture_path),
        }
    else:
        report = run_live(args, fixture, fixture_path)
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        output = safe_output_path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
        summary = report.get("summary")
        print(json.dumps({
            "output": str(output),
            "evidenceSha256": report.get("evidenceSha256"),
            "summary": summary,
        }, indent=2))
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except (OSError, ValueError, RuntimeError) as error:
        sys.stderr.write(f"Attention shadow probe failed: {error}\n")
        raise SystemExit(1)
