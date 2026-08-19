#!/usr/bin/env python3
"""Comparative tool-call judge for fold surfacing, the first generative probe.

Every prior scorer in this program was single-token constrained likelihood over
independent per-fold prompts, and all of it died at the precision-first action
boundary. This mechanism changes the computation on three axes at once: the
model sees EVERY fold's complete expansion in one prompt and compares, it may
reason in ordinary tokens before answering, and abstention is a first-class
answer rather than a threshold on a margin. There is no threshold anywhere.

The decision rule is order invariance: each event is judged twice, once in the
case's rotation order and once reversed. The judge offers only when both passes
name the SAME fold; a null in either pass, a disagreement, or a malformed
answer abstains, each counted under its own name. A correct offer is a positive
event whose named fold is the exact theme fold; every other offer is false.

The development gate is pre-registered: at least 4 offers with observed
precision 1.0 earns a sealed validation, else the mechanism is dead at
development. Validation is deliberately NOT implemented here: this fixture's
validation split (K) is burned because its trials were read during the gate 91
rejection, so a passing development result owes a freshly authored split in a
new fixture before any validation may run. This probe scores the development
split only.

Generation is bounded locally at MAX_NEW_TOKENS as an instrument necessity, not
a provider ceiling: an answer that hits the bound is a named refusal, never a
silently truncated answer. No provider or network calls happen; the default dry
run and self-test load no model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import probe_attention_utility as utility

PROTOCOL_VERSION = 1
SCORER_ID = "granite3.3-comparative-toolcall-judge-v1"
DEFAULT_MODEL = "ibm-granite/granite-3.3-2b-instruct"
EXPECTED_REVISION = "707f574c62054322f6b5b04b6d075f0a8f05e0f0"
MAX_NEW_TOKENS = 160
MINIMUM_OFFERS = 4
REQUIRED_PRECISION = 1.0

PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_FIXTURE = PROJECT / "scripts" / "fixtures" / "attention_utility_v1.json"
DEFAULT_OUT_DIR = PROJECT / "lab" / "attention-shadow"

SYSTEM_PROMPT = (
    "You are a context auditor for an agent whose older material is folded away "
    "behind short summaries. You see the active context, the current task, and "
    "the complete hidden content of every folded region. Decide whether exactly "
    "one fold must be expanded RIGHT NOW because it contains stated evidence "
    "that the current task needs and the active context does not already "
    "supply. Expanding interrupts the agent, so expand only when the task "
    "cannot be answered correctly and completely without that fold. If the "
    "active context already contains what the task needs, or no fold contains "
    "it, or the task does not need hidden evidence, answer null. Reply with "
    'exactly one JSON object on one line: {"expand": "<foldId>"} or '
    '{"expand": null}. No other text after the JSON object.'
)


def refuse(condition: bool, name: str) -> None:
    if not condition:
        raise SystemExit(f"toolcall-judge-refusal:{name}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def judge_user_prompt(case: dict[str, Any], folds: list[dict[str, Any]]) -> str:
    """One comparative prompt carrying every fold's complete expansion."""
    refuse(len(folds) >= 2, "needs-at-least-two-folds")
    seen: set[str] = set()
    blocks = []
    for fold in folds:
        refuse(fold["foldId"] not in seen, f"duplicate-fold:{fold['foldId']}")
        seen.add(fold["foldId"])
        parent = fold["parentFoldId"] if fold["parentFoldId"] is not None else "root"
        blocks.append(
            f'<FOLD id="{fold["foldId"]}" parent="{parent}" depth="{fold["depth"]}">\n'
            f'{fold["expandedContent"]}\n'
            "</FOLD>"
        )
    return (
        f'<EVENT kind="{case["eventKind"]}">\n'
        "This snapshot was taken immediately after this event boundary.\n"
        "</EVENT>\n\n<ACTIVE_CONTEXT>\n"
        f'{case["activeContext"]}\n'
        "</ACTIVE_CONTEXT>\n\n<CURRENT_TASK>\n"
        f'{case["task"]}\n'
        "</CURRENT_TASK>\n\n<FOLDED_REGIONS>\n"
        + "\n\n".join(blocks)
        + "\n</FOLDED_REGIONS>\n\n"
        "Must exactly one fold be expanded right now for this task? "
        "Answer with the JSON object only."
    )


ANSWER_PATTERN = re.compile(r'\{\s*"expand"\s*:\s*(null|"([A-Za-z0-9_-]+)")\s*\}')


def parse_judge_answer(text: str, fold_ids: set[str]) -> dict[str, Any]:
    """Strict parse: exactly one answer object, fold id must exist.

    Returns {"answer": foldId | None} on a clean parse, or
    {"malformed": <reason>} which abstains under its own name.
    """
    matches = list(ANSWER_PATTERN.finditer(text))
    if len(matches) != 1:
        return {"malformed": f"answer-objects:{len(matches)}"}
    match = matches[0]
    tail = text[match.end():].strip()
    if tail:
        return {"malformed": "text-after-answer"}
    if match.group(1) == "null":
        return {"answer": None}
    fold_id = match.group(2)
    if fold_id not in fold_ids:
        return {"malformed": f"unknown-fold:{fold_id}"}
    return {"answer": fold_id}


def judge_decision(forward_pass: dict[str, Any], reverse_pass: dict[str, Any]) -> dict[str, Any]:
    """Order-invariance rule: offer only when both passes name the same fold."""
    for name, judged in (("forward", forward_pass), ("reverse", reverse_pass)):
        if "malformed" in judged:
            return {"action": "abstain", "reason": f"malformed-{name}:{judged['malformed']}"}
    forward = forward_pass["answer"]
    reverse = reverse_pass["answer"]
    if forward is None and reverse is None:
        return {"action": "abstain", "reason": "both-null"}
    if forward is None or reverse is None:
        return {"action": "abstain", "reason": "one-null"}
    if forward != reverse:
        return {"action": "abstain", "reason": f"order-disagreement:{forward}!={reverse}"}
    return {"action": "offer", "foldId": forward}


def judge_offer_outcome(case: dict[str, Any], decision: dict[str, Any]) -> dict[str, Any]:
    """Labels join after the decision. A wrong fold on a positive event is false."""
    if decision["action"] != "offer":
        return {"offered": False, "correct": None}
    correct = case["class"] == "positive" and decision["foldId"] == case["themeFoldId"]
    return {"offered": True, "correct": correct}


def development_gate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Pre-registered: at least MINIMUM_OFFERS offers at precision 1.0 earns a
    sealed validation on a FRESH split; anything else is dead at development."""
    offers = [row for row in rows if row["offered"]]
    correct = [row for row in offers if row["correct"]]
    false_offers = len(offers) - len(correct)
    opportunities = sum(1 for row in rows if row["class"] == "positive")
    precision = len(correct) / len(offers) if offers else None
    earned = len(offers) >= MINIMUM_OFFERS and false_offers == 0
    return {
        "turns": len(rows),
        "offers": len(offers),
        "correctOffers": len(correct),
        "falseOffers": false_offers,
        "precision": precision,
        "opportunities": opportunities,
        "recall": len(correct) / opportunities if opportunities else None,
        "minimumOffers": MINIMUM_OFFERS,
        "requiredPrecision": REQUIRED_PRECISION,
        "earnsValidation": earned,
        "validation": "owes-a-fresh-split" if earned else "dead-at-development",
    }


def self_test() -> dict:
    fold_ids = {"J1", "J2"}
    assert parse_judge_answer('{"expand": "J1"}', fold_ids) == {"answer": "J1"}
    assert parse_judge_answer('I think... {"expand": null}', fold_ids) == {"answer": None}
    assert "malformed" in parse_judge_answer('{"expand": "J9"}', fold_ids)
    assert "malformed" in parse_judge_answer('{"expand": "J1"} trailing', fold_ids)
    assert "malformed" in parse_judge_answer(
        '{"expand": "J1"} {"expand": "J2"}', fold_ids)
    assert "malformed" in parse_judge_answer("no object at all", fold_ids)

    assert judge_decision({"answer": "J1"}, {"answer": "J1"}) == {
        "action": "offer", "foldId": "J1"}
    assert judge_decision({"answer": "J1"}, {"answer": "J2"})["reason"].startswith(
        "order-disagreement")
    assert judge_decision({"answer": None}, {"answer": None})["reason"] == "both-null"
    assert judge_decision({"answer": "J1"}, {"answer": None})["reason"] == "one-null"
    assert judge_decision({"malformed": "x"}, {"answer": "J1"})["reason"].startswith(
        "malformed-forward")

    positive = {"class": "positive", "themeFoldId": "J1"}
    visible = {"class": "already-visible", "themeFoldId": "J1"}
    offer = {"action": "offer", "foldId": "J1"}
    assert judge_offer_outcome(positive, offer) == {"offered": True, "correct": True}
    assert judge_offer_outcome(visible, offer) == {"offered": True, "correct": False}
    assert judge_offer_outcome(positive, {"action": "abstain", "reason": "both-null"}) == {
        "offered": False, "correct": None}

    def row(cls, offered, correct):
        return {"class": cls, "offered": offered, "correct": correct}
    passing = [row("positive", True, True)] * 4 + [row("no-relevant", False, None)] * 4
    gate = development_gate(passing)
    assert gate["earnsValidation"] is True and gate["validation"] == "owes-a-fresh-split"
    tainted = development_gate(passing + [row("already-visible", True, False)])
    assert tainted["earnsValidation"] is False
    sparse = development_gate([row("positive", True, True)] * 3)
    assert sparse["earnsValidation"] is False

    case = {"eventKind": "stop", "activeContext": "ctx", "task": "task"}
    folds = [
        {"foldId": "J1", "parentFoldId": None, "depth": 0, "expandedContent": "alpha"},
        {"foldId": "J2", "parentFoldId": "J1", "depth": 1, "expandedContent": "beta"},
    ]
    prompt = judge_user_prompt(case, folds)
    reversed_prompt = judge_user_prompt(case, list(reversed(folds)))
    assert prompt.count("<FOLD ") == 2 and reversed_prompt.count("<FOLD ") == 2
    assert prompt != reversed_prompt
    assert "alpha" in prompt and "beta" in prompt

    return {
        "scorerId": SCORER_ID,
        "protocolVersion": PROTOCOL_VERSION,
        "minimumOffers": MINIMUM_OFFERS,
        "requiredPrecision": REQUIRED_PRECISION,
        "maxNewTokens": MAX_NEW_TOKENS,
        "orderInvarianceRequired": True,
        "thresholds": 0,
        "developmentSplitOnly": True,
        "validationSplitBurned": "K trials were read during the gate 91 rejection",
        "modelLoads": 0,
        "networkRequests": 0,
    }


def run_live(args: argparse.Namespace, fixture: dict[str, Any], fixture_path: Path) -> dict:
    import torch
    from transformers import (AutoConfig, AutoModelForCausalLM, AutoTokenizer,
                              BitsAndBytesConfig)

    refuse(torch.cuda.is_available(), "cuda-unavailable")
    load_started = time.perf_counter()
    config = AutoConfig.from_pretrained(args.model, local_files_only=args.offline)
    refuse(getattr(config, "_commit_hash", None) == EXPECTED_REVISION,
           f"model-revision-drift:{getattr(config, '_commit_hash', None)}")
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=args.offline)
    refuse(bool(getattr(tokenizer, "is_fast", False)), "needs-fast-tokenizer")
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_quant_storage=torch.uint8,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        config=config,
        quantization_config=quantization,
        device_map={"": 0},
        low_cpu_mem_usage=True,
        local_files_only=args.offline,
    ).eval()
    load_seconds = time.perf_counter() - load_started

    split = fixture["splits"]["development"]
    folds = split["folds"]
    fold_ids = {fold["foldId"] for fold in folds}
    folds_by_id = {fold["foldId"]: fold for fold in folds}
    import probe_attention_shadow as attention
    orders = attention.rotations(list(folds_by_id))

    def generate(case: dict[str, Any], order: list[str]) -> dict[str, Any]:
        user = judge_user_prompt(case, [folds_by_id[fold_id] for fold_id in order])
        rendered = tokenizer.apply_chat_template(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": user}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False)
        for fold in folds:
            refuse(rendered.count(fold["expandedContent"]) == 1,
                   f"chat-template-fold-count:{fold['foldId']}")
        encoded = tokenizer(rendered, return_tensors="pt").to("cuda")
        started = time.perf_counter()
        with torch.no_grad():
            output = model.generate(
                **encoded,
                max_new_tokens=MAX_NEW_TOKENS,
                do_sample=False,
                pad_token_id=tokenizer.eos_token_id,
            )
        seconds = time.perf_counter() - started
        generated_ids = output[0, encoded["input_ids"].shape[1]:]
        text = tokenizer.decode(generated_ids, skip_special_tokens=True).strip()
        hit_bound = int(generated_ids.shape[0]) >= MAX_NEW_TOKENS
        judged = ({"malformed": "generation-bound-hit"} if hit_bound
                  else parse_judge_answer(text, fold_ids))
        return {
            "order": order,
            "inputTokens": int(encoded["input_ids"].shape[1]),
            "generatedTokens": int(generated_ids.shape[0]),
            "generationSeconds": seconds,
            "textSha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text,
            "judged": judged,
        }

    rows = []
    score_started = time.perf_counter()
    for case in utility.expanded_cases(split):
        order = orders[case["rotation"]]
        forward_pass = generate(case, order)
        reverse_pass = generate(case, list(reversed(order)))
        decision = judge_decision(forward_pass["judged"], reverse_pass["judged"])
        outcome = judge_offer_outcome(case, decision)
        rows.append({
            "caseId": case["id"],
            "class": case["class"],
            "eventKind": case["eventKind"],
            "themeFoldId": case["themeFoldId"],
            "decision": decision,
            **outcome,
            "forward": forward_pass,
            "reverse": reverse_pass,
        })
    gate = development_gate(rows)
    total_generation = sum(row["forward"]["generationSeconds"] +
                           row["reverse"]["generationSeconds"] for row in rows)
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "experiment": "comparative tool-call judge, development split",
        "scorerId": SCORER_ID,
        "systemPromptSha256": hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest(),
        "model": {
            "id": args.model,
            "revision": getattr(config, "_commit_hash", None),
            "quantization": "bitsandbytes-nf4",
            "parameters": int(model.num_parameters()),
            "maxNewTokens": MAX_NEW_TOKENS,
            "decoding": "greedy",
        },
        "fixtureSha256": sha256_file(fixture_path),
        "scriptSha256": sha256_file(Path(__file__).resolve()),
        "development": gate,
        "abstentions": {
            row["caseId"]: row["decision"]["reason"]
            for row in rows if row["decision"]["action"] == "abstain"
        },
        "runtime": {
            "loadSeconds": load_seconds,
            "scoreSeconds": time.perf_counter() - score_started,
            "generationSeconds": total_generation,
            "generations": 2 * len(rows),
            "peakAllocatedBytes": int(torch.cuda.max_memory_allocated()),
            "peakReservedBytes": int(torch.cuda.max_memory_reserved()),
        },
        "rows": rows,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Comparative tool-call judge over the development split. The default "
            "dry run loads no model and makes no provider or network calls."
        ))
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
    refuse(fixture_path.is_file(), f"fixture-missing:{fixture_path}")
    fixture = utility.load_fixture(fixture_path)
    if args.live:
        report = run_live(args, fixture, fixture_path)
    else:
        report = {
            "live": False,
            "modelLoads": 0,
            "networkRequests": 0,
            "selfTest": self_test(),
            "fixtureSha256": sha256_file(fixture_path),
            "developmentCases": len(utility.expanded_cases(fixture["splits"]["development"])),
        }
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        output = Path(args.output).expanduser().resolve()
        refuse(str(output).startswith(str(DEFAULT_OUT_DIR)),
               f"output-outside:{DEFAULT_OUT_DIR}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded, encoding="utf-8")
        print(json.dumps({"output": str(output),
                          "development": report.get("development")}, indent=2))
    else:
        print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
