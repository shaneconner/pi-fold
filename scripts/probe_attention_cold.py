#!/usr/bin/env python3
"""Value-weighted anchor-relative attention scorer for the cold-detection shadow.

Reads the cold-shadow manifest (scripts/probe_cold_shadow.mjs extract), scores
every (moment, eligible unit) pair with a local probe model, and writes scores
for the Node summarizer to join with labels. The manifest carries no labels and
this scorer refuses by name if label fields appear in its input. No provider or
network calls happen; the default dry run and self-test load no model.

Signal: for each prompt [unit block text][anchor text][readout cue], take the
readout-cue rows of eager attention on the selected upper layers, weight each
attended position by the L2 norm of its value vector (GQA-expanded), and form
per-token masses for the block span and the anchor span. The block ratio is
block mass per token divided by anchor mass per token. A unit longer than the
block bound is scored in complete consecutive blocks against the same anchor,
token-weighted; every byte is scored and nothing is sliced away. A pair whose
anchor plus cue alone exceed the prompt bound is refused by name and reported.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

PROTOCOL_VERSION = 1
SCORER_ID = "qwen3-value-weighted-anchor-ratio-v1"
DEFAULT_MODEL = "Qwen/Qwen3-0.6B"
EXPECTED_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca"
READOUT_CUE = "\nEvidence above that is still needed for the current task:"
UPPER_LAYER_FRACTION = 0.75  # layers at or past this fraction of depth are read
BLOCK_TOKEN_LIMIT = 3072
PROMPT_TOKEN_LIMIT = 4096
FORBIDDEN_MANIFEST_KEYS = ("laterNeededUnitIds", "stalenessPickIds", "questions")

PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = PROJECT / "lab" / "cold-shadow"


def refuse(condition: bool, name: str) -> None:
    if not condition:
        raise SystemExit(f"cold-scorer-refusal:{name}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expand_kv_norms(value_norms, query_heads: int):
    """Expand per-kv-head value norms to query heads for GQA attention.

    value_norms has shape [kv_heads, positions]; each kv head serves
    query_heads // kv_heads consecutive query heads.
    """
    kv_heads = value_norms.shape[0]
    refuse(query_heads % kv_heads == 0, "gqa-head-mismatch")
    repeat = query_heads // kv_heads
    return value_norms.repeat_interleave(repeat, dim=0)


def weighted_span_mass(attention_rows, value_norms, span) -> float:
    """Mean per-token value-weighted attention mass over a position span.

    attention_rows: [heads, readout_rows, positions] for one layer.
    value_norms: [heads, positions] (already GQA-expanded).
    span: (start, end) position bounds, end exclusive.
    """
    start, end = span
    refuse(end > start, "empty-span")
    weighted = attention_rows[:, :, start:end] * value_norms[:, None, start:end]
    return float(weighted.sum().item()) / float(end - start)


def block_spans(token_count: int, limit: int) -> list[tuple[int, int]]:
    """Complete consecutive block coverage; every token lands in one block."""
    refuse(token_count > 0, "unit-has-no-tokens")
    spans = []
    start = 0
    while start < token_count:
        spans.append((start, min(start + limit, token_count)))
        start += limit
    return spans


def combine_block_ratios(blocks: list[dict]) -> float:
    """Token-weighted mean of block ratios; every block carries its weight."""
    total = sum(block["tokens"] for block in blocks)
    refuse(total > 0, "no-block-tokens")
    return sum(block["ratio"] * block["tokens"] for block in blocks) / total


def validate_manifest(manifest: dict) -> None:
    encoded = json.dumps(manifest)
    for key in FORBIDDEN_MANIFEST_KEYS:
        refuse(f'"{key}"' not in encoded, f"label-field-in-scorer-input:{key}")
    refuse(manifest.get("protocolVersion") == PROTOCOL_VERSION, "manifest-protocol-drift")
    refuse(manifest.get("scorerId") == SCORER_ID, "manifest-scorer-drift")


def self_test() -> dict:
    # The tensor checks need torch; a machine without it (CI verifies the offline
    # contract only) reports that BY NAME rather than failing the pure checks or
    # silently pretending the tensor checks ran.
    try:
        import torch
    except ModuleNotFoundError:
        torch = None
    if torch is None:
        tensor_checks = "torch-unavailable"
    else:
        norms = torch.tensor([[1.0, 2.0, 3.0, 4.0], [5.0, 6.0, 7.0, 8.0]])
        expanded = expand_kv_norms(norms, 4)
        assert expanded.shape == (4, 4)
        assert torch.equal(expanded[0], expanded[1]) and torch.equal(expanded[2], expanded[3])

        attention = torch.ones((4, 2, 4)) * 0.25
        mass_front = weighted_span_mass(attention, expanded, (0, 2))
        mass_back = weighted_span_mass(attention, expanded, (2, 4))
        assert mass_back > mass_front  # larger value norms carry more mass
        tensor_checks = "verified"

    spans = block_spans(10, 4)
    assert spans == [(0, 4), (4, 8), (8, 10)]
    assert sum(end - start for start, end in spans) == 10

    combined = combine_block_ratios([
        {"ratio": 1.0, "tokens": 4}, {"ratio": 4.0, "tokens": 4}, {"ratio": 10.0, "tokens": 2},
    ])
    assert abs(combined - 4.0) < 1e-9

    try:
        validate_manifest({"protocolVersion": PROTOCOL_VERSION, "scorerId": SCORER_ID,
                           "runs": [{"stalenessPickIds": []}]})
        raise AssertionError("label field passed the scorer input validation")
    except SystemExit as error:
        assert "label-field-in-scorer-input" in str(error)

    return {
        "scorerId": SCORER_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "blockTokenLimit": BLOCK_TOKEN_LIMIT,
        "promptTokenLimit": PROMPT_TOKEN_LIMIT,
        "upperLayerFraction": UPPER_LAYER_FRACTION,
        "readoutCue": READOUT_CUE,
        "tensorChecks": tensor_checks,
        "labelFieldsRefused": list(FORBIDDEN_MANIFEST_KEYS),
        "everyByteScored": True,
        "modelLoads": 0,
        "networkRequests": 0,
    }


def run_live(args: argparse.Namespace, manifest: dict, manifest_path: Path) -> dict:
    import torch
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer

    refuse(torch.cuda.is_available(), "cuda-unavailable")
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(config, "_commit_hash", None) == EXPECTED_REVISION,
           f"model-revision-drift:{getattr(config, '_commit_hash', None)}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(bool(getattr(tokenizer, "is_fast", False)), "needs-fast-tokenizer")
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        torch_dtype=torch.float16,
        attn_implementation="eager",
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).to("cuda").eval()
    load_seconds = time.perf_counter() - load_started

    layer_count = int(model.config.num_hidden_layers)
    first_layer = int(layer_count * UPPER_LAYER_FRACTION)
    selected_layers = list(range(first_layer, layer_count))
    refuse(bool(selected_layers), "selected-no-layers")
    query_heads = int(model.config.num_attention_heads)

    captured: dict[int, "torch.Tensor"] = {}
    readout_start_holder = {"value": None}

    def make_hook(layer_index: int, selected: bool):
        def hook(_module, _args, output):
            attn_output, attn_weights = output[0], output[1]
            if selected and attn_weights is not None:
                start = readout_start_holder["value"]
                captured[layer_index] = attn_weights[0, :, start:, :].detach().float().cpu()
            return (attn_output, None) + tuple(output[2:])
        return hook

    hooks = []
    for layer_index, layer in enumerate(model.model.layers):
        hooks.append(layer.self_attn.register_forward_hook(
            make_hook(layer_index, layer_index in selected_layers)))

    def score_prompt(block_text: str, anchor_text: str) -> dict:
        prompt = block_text + "\n\n" + anchor_text + READOUT_CUE
        encoded = tokenizer(prompt, return_offsets_mapping=True, return_tensors="pt")
        offsets = encoded.pop("offset_mapping")[0].tolist()
        token_count = encoded["input_ids"].shape[1]
        refuse(token_count <= PROMPT_TOKEN_LIMIT, f"prompt-over-bound:{token_count}")
        block_end_char = len(block_text)
        anchor_start_char = block_end_char + 2
        anchor_end_char = anchor_start_char + len(anchor_text)
        block_positions = [index for index, (start, end) in enumerate(offsets)
                           if end > 0 and start < block_end_char]
        anchor_positions = [index for index, (start, end) in enumerate(offsets)
                            if start >= anchor_start_char and start < anchor_end_char and end > start]
        cue_positions = [index for index, (start, end) in enumerate(offsets)
                         if start >= anchor_end_char and end > start]
        refuse(bool(block_positions), "no-block-positions")
        refuse(bool(anchor_positions), "no-anchor-positions")
        refuse(bool(cue_positions), "no-cue-positions")
        block_span = (min(block_positions), max(block_positions) + 1)
        anchor_span = (min(anchor_positions), max(anchor_positions) + 1)
        readout_start_holder["value"] = min(cue_positions)
        captured.clear()
        with torch.no_grad():
            outputs = model(
                input_ids=encoded["input_ids"].to("cuda"),
                attention_mask=encoded["attention_mask"].to("cuda"),
                output_attentions=True,
                use_cache=True,
            )
        refuse(len(captured) == len(selected_layers), "attention-capture-missing-layers")
        block_mass = 0.0
        anchor_mass = 0.0
        for layer_index in selected_layers:
            values = outputs.past_key_values.layers[layer_index].values \
                if hasattr(outputs.past_key_values, "layers") \
                else outputs.past_key_values[layer_index][1]
            norms = values[0].norm(dim=-1).float().cpu()  # [kv_heads, positions]
            expanded = expand_kv_norms(norms, query_heads)
            rows = captured[layer_index]  # [heads, readout_rows, positions]
            block_mass += weighted_span_mass(rows, expanded, block_span)
            anchor_mass += weighted_span_mass(rows, expanded, anchor_span)
        del outputs
        refuse(anchor_mass > 0, "anchor-mass-zero")
        return {
            "ratio": block_mass / anchor_mass,
            "tokens": block_span[1] - block_span[0],
            "promptTokens": token_count,
        }

    runs_output = []
    forwards = 0
    refusals = []
    score_started = time.perf_counter()
    for run in manifest["runs"]:
        units = run["units"]
        scores = []
        for moment in run["moments"]:
            anchor = moment["anchorText"]
            for unit_id in moment["eligibleUnitIds"]:
                text = units[unit_id]["text"]
                unit_tokens = tokenizer(text, return_tensors="pt")["input_ids"].shape[1]
                try:
                    blocks = []
                    for start, end in block_spans(unit_tokens, BLOCK_TOKEN_LIMIT):
                        block_ids = tokenizer(text, return_tensors="pt")["input_ids"][0, start:end]
                        block_text = tokenizer.decode(block_ids, skip_special_tokens=True)
                        blocks.append(score_prompt(block_text, anchor))
                        forwards += 1
                    scores.append({
                        "momentId": moment["momentId"],
                        "unitId": unit_id,
                        "ratio": combine_block_ratios(blocks),
                        "blocks": len(blocks),
                        "unitTokens": unit_tokens,
                        "refused": False,
                    })
                except SystemExit as error:
                    refusals.append({
                        "momentId": moment["momentId"],
                        "unitId": unit_id,
                        "reason": str(error),
                    })
                    scores.append({
                        "momentId": moment["momentId"],
                        "unitId": unit_id,
                        "ratio": None,
                        "blocks": 0,
                        "unitTokens": unit_tokens,
                        "refused": True,
                    })
        runs_output.append({"runId": run["runId"], "scores": scores})
    for hook in hooks:
        hook.remove()

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "scorerId": SCORER_ID,
        "model": {
            "id": args.model,
            "revision": getattr(config, "_commit_hash", None),
            "layers": layer_count,
            "selectedLayers": selected_layers,
            "attentionHeads": query_heads,
            "attentionImplementation": "eager",
            "dtype": "torch.float16",
        },
        "readoutCue": READOUT_CUE,
        "blockTokenLimit": BLOCK_TOKEN_LIMIT,
        "promptTokenLimit": PROMPT_TOKEN_LIMIT,
        "manifestSha256": sha256_file(manifest_path),
        "scriptSha256": sha256_file(Path(__file__).resolve()),
        "runtime": {
            "loadSeconds": load_seconds,
            "scoreSeconds": time.perf_counter() - score_started,
            "forwards": forwards,
            "peakAllocatedBytes": int(torch.cuda.max_memory_allocated()),
            "peakReservedBytes": int(torch.cuda.max_memory_reserved()),
        },
        "refusals": refusals,
        "runs": runs_output,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Score the cold-shadow manifest with value-weighted anchor-relative "
            "attention. The default dry run loads no model and makes no network request."
        ))
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--device", default="cuda", choices=("cuda",))
    parser.add_argument("--manifest", default=str(DEFAULT_OUT_DIR / "cold-manifest-v1.json"))
    parser.add_argument("--output")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        print(json.dumps(self_test(), indent=2))
        return 0
    manifest_path = Path(args.manifest).expanduser().resolve()
    refuse(manifest_path.is_file(), f"manifest-missing:{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    if args.live:
        report = run_live(args, manifest, manifest_path)
    else:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "selfTest": self_test(),
            "manifestSha256": sha256_file(manifest_path),
            "scoringPairs": sum(len(moment["eligibleUnitIds"])
                                for run in manifest["runs"] for moment in run["moments"]),
        }
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        output = Path(args.output).expanduser().resolve()
        refuse(str(output).startswith(str(DEFAULT_OUT_DIR)),
               f"output-outside:{DEFAULT_OUT_DIR}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
        print(json.dumps({"output": str(output),
                          "manifestSha256": report.get("manifestSha256")}, indent=2))
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
