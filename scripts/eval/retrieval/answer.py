#!/usr/bin/env python3
"""Answer accuracy on the retrieval bench (#1242): each question of the test set is answered by a model from one context strategy,
and the answer is checked with the question's `answer_check`. Needs the bench loaded and indexed (harness.py load index).

Strategies (what the run starts with; no tool loop, so retrieval quality is what differs):
  window40         today's brief: the last 40 messages of the conversation the question is asked in
  search_around    the search page (10 hits of BENCH_ANSWER_SEARCH, default hybrid_bm25) plus the 3 messages before and after
                   each of the top 3 hits, grouped by conversation in time order
  summaries        option D without embeddings: the conversation's stored summaries (one per 100 messages, written by the same
                   model in a first pass, `--build-summaries`) plus the last 40 messages
  window_search    window40 plus search_around (what a run would have if the brief kept the window and added a search)

The model is any OpenAI-compatible Chat Completions endpoint:
  BENCH_LLM_URL (e.g. http://flux-model:8080/v1), BENCH_LLM_KEY, BENCH_LLM_MODEL
  --mock starts a local stand-in that answers with the context line sharing most words with the question: it checks the plumbing
  and token counts only, never a model's accuracy.

  python answer.py [--mock] [--strategies window40,search_around,summaries,window_search] [--build-summaries] [--out out/answers.json]
"""
import argparse
import http.server
import json
import os
import re
import statistics
import threading
import time
from pathlib import Path

import httpx
import tiktoken

import harness

HERE = Path(__file__).resolve().parent
TODAY = "2026-11-10"
SYSTEM = ("You answer questions about a company's team chat. Use only the messages given. Answer in the language of the question, "
          "in one or two sentences, and include the exact figures, names or codes the messages give. If the messages do not contain "
          "the answer, say that you do not know.")
SUMMARY_SYSTEM = ("Summarise these team chat messages for a later reader who must answer questions from your summary alone. Keep every "
                  "decision, figure, date, name, code, number and change of plan, with who said it and when (YYYY-MM-DD). Plain list, "
                  "at most 200 words, in the language the messages mostly use.")
ENC = tiktoken.get_encoding("o200k_base")


def chat(url, key, model, system, user, max_tokens=300):
    start = time.perf_counter()
    response = httpx.post(f"{url}/chat/completions", headers={"Authorization": f"Bearer {key}"} if key else {}, timeout=600, json={
        "model": model, "temperature": 0, "max_tokens": max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
    response.raise_for_status()
    body = response.json()
    usage = body.get("usage") or {}
    return body["choices"][0]["message"]["content"] or "", usage.get("prompt_tokens"), time.perf_counter() - start


class Mock(http.server.BaseHTTPRequestHandler):
    """Answers with the context line that shares most words with the question (plumbing check only)."""

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        text = request["messages"][-1]["content"]
        question = text.rsplit("Question:", 1)[-1]
        words = {w.lower() for w in re.findall(r"\w{4,}", question)}
        lines = [line for line in text.split("\n") if line.startswith("[")] or [""]
        best = max(lines, key=lambda line: len(words & {w.lower() for w in re.findall(r"\w{4,}", line)}))
        body = json.dumps({"choices": [{"message": {"content": best}}], "usage": {"prompt_tokens": len(ENC.encode(text))}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategies", default="window40,search_around,summaries,window_search")
    parser.add_argument("--build-summaries", action="store_true")
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--out", default=str(HERE / "out" / "answers.json"))
    args = parser.parse_args()
    if args.mock:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url, key, model = f"http://127.0.0.1:{server.server_port}", "", "mock"
    else:
        url, key, model = os.environ["BENCH_LLM_URL"].rstrip("/"), os.environ.get("BENCH_LLM_KEY", ""), os.environ["BENCH_LLM_MODEL"]
    data = harness.seed()
    s = harness.Searcher(data)
    agent = harness.principal_of(data, "agent", "fieldbot")
    names = {p["id"]: p["name"] for p in data["people"]}
    rows = {str(r[0]): r for r in s.db.execute("SELECT m.id, c.key, m.sequence, m.author, m.created_at, m.body FROM messages m "
                                               "JOIN conversations c ON c.id = m.conversation_id WHERE m.removed_at IS NULL").fetchall()}

    def render(ids):
        ordered = sorted({i for i in ids if i in rows}, key=lambda i: (rows[i][1], rows[i][2]))
        out, conv = [], None
        for i in ordered:
            if rows[i][1] != conv:
                conv = rows[i][1]; out.append(f"-- conversation {conv}")
            out.append(f"[{rows[i][4]:%Y-%m-%d %H:%M}] {names.get(rows[i][3], rows[i][3])}: {rows[i][5]}")
        return "\n".join(out)

    def around(ids, n=3):
        extra = []
        for i in ids[:3]:
            conv = s.db.execute("SELECT conversation_id, sequence FROM messages WHERE id = %s", (i,)).fetchone()
            extra += [str(r[0]) for r in s.db.execute("SELECT id FROM messages WHERE conversation_id = %s AND sequence BETWEEN %s AND %s",
                                                      (conv[0], conv[1] - n, conv[1] + n)).fetchall()]
        return ids + extra

    summaries_path = HERE / "out" / f"summaries-{re.sub(r'[^A-Za-z0-9.-]', '_', model)}.json"
    if args.build_summaries:
        built = {}
        for conv in {q["asked_in"] for q in data["questions"]}:
            ids = [i for i in sorted((i for i in rows if rows[i][1] == conv), key=lambda i: rows[i][2])]
            built[conv] = []
            for start in range(0, len(ids), 100):
                chunk = ids[start:start + 100]
                text, _, took = chat(url, key, model, SUMMARY_SYSTEM, render(chunk), max_tokens=400)
                built[conv].append({"from": rows[chunk[0]][2], "to": rows[chunk[-1]][2], "sources": chunk, "body": text, "seconds": round(took, 1)})
            print("summaries", conv, len(built[conv]))
        summaries_path.write_text(json.dumps(built, ensure_ascii=False, indent=1))
    summaries = json.loads(summaries_path.read_text()) if summaries_path.exists() else {}
    search_variant = os.environ.get("BENCH_ANSWER_SEARCH", "hybrid_bm25")

    results = {"model": model, "mock": args.mock, "search": search_variant, "strategies": {}}
    for strategy in args.strategies.split(","):
        if strategy == "summaries" and not summaries:
            print("summaries: none built (run with --build-summaries first); skipped")
            continue
        per_q = []
        for q in data["questions"]:
            window = s.window(q["asked_in"])
            if strategy == "window40":
                context = render(window)
            else:
                hits, _ = s.search(search_variant, agent, q["question"], after=q.get("after"), before=q.get("before"))
                found = around(hits)
                if strategy == "search_around":
                    context = render(found)
                elif strategy == "window_search":
                    context = render(found + window)
                else:
                    context = "\n".join(f"(summary of messages {x['from']}–{x['to']}) {x['body']}" for x in summaries.get(q["asked_in"], [])) \
                              + "\n\nLatest messages:\n" + render(window)
            user = f"Today is {TODAY}.\n\nMessages:\n{context}\n\nQuestion: {q['question']}"
            answer, prompt_tokens, took = chat(url, key, model, SYSTEM, user)
            ok = re.search(q["answer_check"], answer, re.I) is not None
            per_q.append({"id": q["id"], "category": q["category"], "ok": ok, "answer": answer[:400],
                          "input_tokens": prompt_tokens or len(ENC.encode(SYSTEM + user)), "seconds": round(took, 2)})
        cats = {}
        for x in per_q:
            cats.setdefault(x["category"], []).append(x["ok"])
        results["strategies"][strategy] = {
            "accuracy": round(statistics.mean(x["ok"] for x in per_q), 3),
            "by_category": {c: round(statistics.mean(v), 2) for c, v in sorted(cats.items())},
            "input_tokens_mean": round(statistics.mean(x["input_tokens"] for x in per_q)),
            "seconds_p50": round(statistics.median(x["seconds"] for x in per_q), 2), "per_question": per_q}
        r = results["strategies"][strategy]
        print(f"answer {strategy:14s} accuracy={r['accuracy']:.3f} tokens={r['input_tokens_mean']} {r['by_category']}")
    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
