#!/usr/bin/env node
/*
 * B-103 / T-819 consumer spike — the exactly-once DELIVERY (handoff) module (§أ-4 consumer
 * protocol, §و/المرحلة 1 criteria 4-5).
 *
 * The delivery contract, proven here on REAL claude transcripts:
 *   handoffId(taskId)  = deterministic content hash (sha256, 128-bit).
 *   ledger             = handoffs/<conversationId>.done — the PRIMARY exactly-once key
 *                        (atomic, batch-level, §أ-2). Written through the SAME atomic path
 *                        seal() uses for DONE (writeFileAtomic, imported from capture-writer).
 *   jsonl reconcile    = the SECONDARY key that closes the crash window BETWEEN an injection
 *                        and its ledger write. Match ONLY on a fully JSON.parse-able line
 *                        carrying handoffId — a torn/half-written line does NOT parse, so it
 *                        is IGNORED and treated "not delivered" (conservative, loss-free).
 *                        This is the §أ-4 row "سطر handoffId نصف-مكتوب" and the whole point
 *                        of criterion 5 (reconcile 6.5% analog): regex would match the torn
 *                        line and wrongly skip → LOSS; JSON.parse does not.
 *
 * finalizeDelivery is idempotent: N repeats on one task ⇒ exactly one handoffId (criterion 4).
 *
 * Documented test-only hooks (mirror the producer's --kill-at-offset / --widen-window-ms):
 *   tearAtOffset K : during injection, write exactly K bytes of the handoff line then SIGKILL
 *                    self BEFORE the newline and BEFORE the ledger — a REAL interrupted
 *                    resume-append. Leaves a torn last line + no ledger (criterion 5 setup).
 *   widenMs W      : sleep W ms BETWEEN a full injection and the ledger write so an external
 *                    kill -9 of the supervisor lands in that gap (criterion 6, hole 2-ب).
 *   matcher regex  : NEGATIVE CONTROL — decide "committed" from a text regex instead of
 *                    JSON.parse, to reproduce the loss the design forbids.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from './capture-writer.mjs';

const CHUNK = 64; // small chunks so tearAtOffset is byte-precise (as in capture-writer)

function sleepMs(ms) {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/** Deterministic, content-addressed handoff id. Same taskId ⇒ same id, always. */
export function handoffId(taskId) {
  return crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 32);
}

export function ledgerPath(stateRoot, conversationId) {
  return path.join(stateRoot, 'handoffs', `${conversationId}.done`);
}

/** Read the per-conversation batch ledger. Missing → null; corrupt → {_unparsable}. */
export function readLedger(stateRoot, conversationId) {
  const p = ledgerPath(stateRoot, conversationId);
  if (!fs.existsSync(p)) return null;
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!o || !Array.isArray(o.entries)) return { _unparsable: true };
    return o;
  } catch { return { _unparsable: true }; }
}

export function ledgerHasTask(ledger, taskId) {
  return !!(ledger && !ledger._unparsable && Array.isArray(ledger.entries)
    && ledger.entries.some((e) => e && e.taskId === taskId));
}

/*
 * Scan the conversation jsonl for a COMMITTED delivery of hId.
 *  - json  (default): a match requires a fully JSON.parse-able line whose handoffId (or an
 *                     entry of handoffIds[]) equals hId. Torn lines are counted but ignored.
 *  - regex (control): a match is any line containing the handoffId TEXT — including a torn
 *                     one — reproducing the unsafe behavior the design rejects.
 * Returns rich counters so criterion 5 can show json vs regex divergence on the SAME file.
 */
export function scanJsonl(jsonlPath, hId, { matcher = 'json' } = {}) {
  const res = { validMatch: false, validMatchCount: 0, regexMatch: false, regexMatchCount: 0,
    tornLines: 0, totalLines: 0, lastLineParseable: null };
  if (!fs.existsSync(jsonlPath)) return res;
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
  const needle = `"handoffId":"${hId}"`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    res.totalLines++;
    const textHit = line.includes(needle);
    if (textHit) { res.regexMatch = true; res.regexMatchCount++; }
    let obj = null, ok = true;
    try { obj = JSON.parse(line); } catch { ok = false; }
    res.lastLineParseable = ok;
    if (!ok) { res.tornLines++; continue; }
    const carries = obj && (obj.handoffId === hId
      || (Array.isArray(obj.handoffIds) && obj.handoffIds.includes(hId)));
    if (carries) { res.validMatch = true; res.validMatchCount++; }
  }
  return res;
}

/** Build a realistic transcript-shaped delivery turn carrying the untrusted, sized result. */
export function buildHandoffLine(conversationId, task, resultObj, hId) {
  const body = JSON.stringify(resultObj);
  const sized = body.length > 32 * 1024
    ? body.slice(0, 32 * 1024) + '…[truncated; full in result.json]' : body;
  const untrusted = `<background_task_result untrusted="true">${sized}</background_task_result>`;
  return {
    type: 'user',
    subtype: 'background_task_handoff',
    handoffId: hId,
    handoffIds: [hId],
    taskId: task.taskId,
    taskIds: [task.taskId],
    sessionId: conversationId,
    parentUuid: task._parentUuid || null,
    uuid: crypto.randomUUID(),
    isSidechain: false,
    userType: 'external',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: untrusted },
  };
}

/*
 * Append the handoff line to the conversation jsonl (the "injection"). With tearAtOffset the
 * process SIGKILLs itself mid-write (BEFORE '\n', BEFORE the ledger) — a genuine interrupted
 * append that leaves a torn last line, exactly as a resume process death would.
 */
export function injectHandoffLine(jsonlPath, lineObj, { tearAtOffset = null } = {}) {
  // Defensive newline guard (a real correctness requirement the torn-line scenario surfaced):
  // if a PRIOR append was interrupted, the file ends WITHOUT '\n'. Appending directly would
  // concatenate onto that torn fragment and corrupt the new line too. So start on a fresh line.
  let prefix = '';
  try {
    const st = fs.statSync(jsonlPath);
    if (st.size > 0) {
      const rfd = fs.openSync(jsonlPath, 'r');
      const last = Buffer.alloc(1);
      try { fs.readSync(rfd, last, 0, 1, st.size - 1); } finally { fs.closeSync(rfd); }
      if (last[0] !== 0x0a) prefix = '\n';
    }
  } catch { /* missing file → no prefix */ }
  const payload = Buffer.from(prefix + JSON.stringify(lineObj) + '\n');
  const fd = fs.openSync(jsonlPath, 'a');
  try {
    if (tearAtOffset == null) { fs.writeSync(fd, payload); fs.fsyncSync(fd); return payload.length; }
    let written = 0;
    while (written < payload.length) {
      let end = Math.min(written + CHUNK, payload.length);
      if (written < tearAtOffset && tearAtOffset <= end) end = tearAtOffset;
      fs.writeSync(fd, payload, written, end - written);
      written = end;
      if (written === tearAtOffset) { fs.fsyncSync(fd); process.kill(process.pid, 'SIGKILL'); }
    }
    fs.fsyncSync(fd);
    return payload.length;
  } finally { fs.closeSync(fd); }
}

/** Merge one delivery entry into the batch ledger and commit it atomically (tmp→rename). */
export function writeLedgerEntry(stateRoot, conversationId, entry) {
  const dir = path.join(stateRoot, 'handoffs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prev = readLedger(stateRoot, conversationId);
  const entries = (prev && !prev._unparsable && Array.isArray(prev.entries)) ? prev.entries.slice() : [];
  if (!entries.some((e) => e.taskId === entry.taskId)) entries.push(entry);
  const doc = { schema: 't819-handoff-ledger-1', conversationId, entries,
    committedAt: new Date().toISOString() };
  writeFileAtomic(dir, `${conversationId}.done`, Buffer.from(JSON.stringify(doc) + '\n'));
}

/*
 * The exactly-once delivery step. Returns a structured action for the actions log/evidence.
 * Order: ledger (primary) → jsonl reconcile (secondary) → inject → ledger.
 */
export function finalizeDelivery(opts, hooks = {}) {
  const { stateRoot, task, jsonlPath, resultObj, outcome = 'SUCCEEDED' } = opts;
  const { matcher = 'json', tearAtOffset = null, widenMs = 0, injectedMarkerPath = null } = hooks;
  const conversationId = task.conversationId;
  const hId = handoffId(task.taskId);
  const base = { taskId: task.taskId, conversationId, handoffId: hId, ts: new Date().toISOString() };

  // (1) Primary key: the batch ledger. Already recorded ⇒ idempotent no-op.
  const ledger = readLedger(stateRoot, conversationId);
  if (ledgerHasTask(ledger, task.taskId)) {
    return { ...base, event: 'skip-ledger-hit', injected: false, ledgerWritten: false, delivered: true };
  }

  // Card-only outcomes (PARTIAL/CRASHED, §ج-2): record in ledger, NO jsonl injection, no LLM.
  if (outcome !== 'SUCCEEDED') {
    writeLedgerEntry(stateRoot, conversationId, { taskId: task.taskId, handoffId: hId, outcome,
      committedAt: new Date().toISOString() });
    return { ...base, event: 'card-only', outcome, injected: false, ledgerWritten: true, delivered: true };
  }

  // (2) Ledger absent → reconcile from jsonl. The matcher choice IS the guarantee under test.
  const scan = scanJsonl(jsonlPath, hId, { matcher });
  const committed = matcher === 'regex' ? scan.regexMatch : scan.validMatch;
  if (committed) {
    // Injection already committed but ledger not written (crash window) → repair ledger only.
    // NB: in regex mode a TORN line trips this branch ⇒ ledger claims delivered with NO valid
    // line ⇒ LOSS. That divergence is exactly what criterion 5 measures.
    writeLedgerEntry(stateRoot, conversationId, { taskId: task.taskId, handoffId: hId,
      outcome: 'SUCCEEDED', committedAt: new Date().toISOString() });
    return { ...base, event: 'ledger-repair', injected: false, ledgerWritten: true, delivered: true, scan };
  }

  // (3) Not committed (no line, or only a torn one) → inject, then ledger.
  injectHandoffLine(jsonlPath, buildHandoffLine(conversationId, task, resultObj, hId),
    { tearAtOffset }); // may SIGKILL self here (tear) → dies before markers/ledger
  if (injectedMarkerPath) { try { fs.writeFileSync(injectedMarkerPath, hId); } catch { /* best-effort */ } }
  if (widenMs > 0) sleepMs(widenMs); // crash window for a supervisor kill -9 (test-only)
  writeLedgerEntry(stateRoot, conversationId, { taskId: task.taskId, handoffId: hId,
    outcome: 'SUCCEEDED', committedAt: new Date().toISOString() });
  if (injectedMarkerPath) { try { fs.unlinkSync(injectedMarkerPath); } catch { /* best-effort */ } }
  return { ...base, event: 'inject+ledger', injected: true, ledgerWritten: true, delivered: true, scan };
}
