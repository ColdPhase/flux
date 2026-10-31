#!/usr/bin/env python3
"""Restore BETWEEN in CHECK constraints of a pg_dump text (stdin -> stdout), for scripts/db_baseline.sh.

PostgreSQL keeps `x BETWEEN l AND h AND y` as a nested AND whose left arm is the BETWEEN pair, but
prints it as `(((x >= l) AND (x <= h)) AND y)`. Read back, that text is one flat AND, so a database
built from the dump differs from the one built from the migrations. Only a BETWEEN produces that
nested left arm (the parser flattens every other `(a AND b) AND c`), so writing exactly those arms
as `(x BETWEEN l AND h)` again stores the original tree. db_baseline.sh diff verifies the result.
"""
import re
import sys


def skip_quote(text, i):
    """Index just after the SQL string literal that starts at text[i] ('' is an escaped quote)."""
    i += 1
    while i < len(text):
        if text[i] == "'":
            if text.startswith("''", i):
                i += 2
                continue
            return i + 1
        i += 1
    raise ValueError(f'unterminated literal: {text[:80]}')


def close_of(text, start):
    """Index of the parenthesis closing the one at text[start]."""
    depth, i = 0, start
    while i < len(text):
        c = text[i]
        if c == "'":
            i = skip_quote(text, i)
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError(f'unbalanced: {text[start:start + 80]}')


def top_level_and(body):
    """Split an expression on AND at depth 0, or None if it has no such AND."""
    terms, depth, last, i = [], 0, 0, 0
    while i < len(body):
        c = body[i]
        if c == "'":
            i = skip_quote(body, i)
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        elif depth == 0 and body.startswith(' AND ', i):
            terms.append(body[last:i])
            last = i + 5
            i += 5
            continue
        i += 1
    terms.append(body[last:])
    return terms if len(terms) > 1 else None


PAIR = re.compile(r'^\((?P<x>.+) >= (?P<l>.+)\)$')
UPPER = re.compile(r'^\((?P<x>.+) <= (?P<h>.+)\)$')


def between(term):
    """`((x >= l) AND (x <= h))` -> `(x BETWEEN l AND h)`, else None."""
    if not (term.startswith('(') and close_of(term, 0) == len(term) - 1):
        return None
    parts = top_level_and(term[1:-1])
    if not parts or len(parts) != 2:
        return None
    low, high = PAIR.match(parts[0]), UPPER.match(parts[1])
    if not low or not high or low['x'] != high['x']:
        return None
    return f"({low['x']} BETWEEN {low['l']} AND {high['h']})"


def rewrite(expr):
    """Rewrite every parenthesized group of expr, innermost first."""
    out, i = [], 0
    while i < len(expr):
        if expr[i] == "'":
            j = skip_quote(expr, i)
            out.append(expr[i:j])
            i = j
        elif expr[i] == '(':
            end = close_of(expr, i)
            inner = rewrite(expr[i + 1:end])
            terms = top_level_and(inner)
            if terms:
                first = between(terms[0])
                if first:
                    inner = ' AND '.join([first] + terms[1:])
            out.append('(' + inner + ')')
            i = end + 1
        else:
            out.append(expr[i])
            i += 1
    return ''.join(out)


text, out, i = sys.stdin.read(), [], 0
while True:
    at = text.find(' CHECK (', i)
    if at < 0:
        break
    start = at + len(' CHECK ')
    end = close_of(text, start)  # a literal in the CHECK may span lines
    out.append(text[i:start] + rewrite(text[start:end + 1]))
    i = end + 1
out.append(text[i:])
sys.stdout.write(''.join(out))
