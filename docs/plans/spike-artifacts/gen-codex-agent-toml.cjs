#!/usr/bin/env node
/**
 * SPIKE PROTOTYPE — NOT PRODUCTION.
 * Converts a nassaj agent card (nassaj-core/agents/<name>.md) into a Codex
 * custom-agent TOML (schema codex-cli 0.144.1, §10 of the spike design).
 *
 * Deliberately standalone: NOT wired to provision-user-dirs.js or any product
 * code. Wiring happens only AFTER Gate 1B verifies identity actually loads.
 *
 * Usage:
 *   node gen-codex-agent-toml.js <card.md> <out.toml> [--canary "<token>"]
 *
 * schema (0.144.1): required name/description/developer_instructions;
 * optional sandbox_mode, model, model_reasoning_effort. Identity is the `name`
 * field (NOT the filename). Claude model ids are DROPPED (would break Codex —
 * §10 critical transform rule: child inherits parent model instead).
 */
'use strict';
const fs = require('fs');

function parseCard(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('card missing frontmatter');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv && kv[2] && !kv[2].startsWith('#')) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2].trim() };
}

// TOML basic-string escaping for a triple-quoted literal is not needed; we use
// a multi-line basic string ("""). Escape backslash and the triple-quote seq.
function tomlMultiline(s) {
  return s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

function build(cardPath, canary) {
  const { fm, body } = parseCard(fs.readFileSync(cardPath, 'utf8'));
  const name = fm.name;
  if (!name) throw new Error('card missing name');
  const description = fm.description || fm.role || name;

  // developer_instructions = persona + role boundaries + governance contract.
  // We PREPEND an explicit leaf/role contract (§10 "الحقن الأساسي") and the
  // canary line (Gate 1B supporting signal), then the full card body which
  // already carries المسؤوليات / قواعد التخصص / بوابات الرفض.
  const canaryLine = canary
    ? `\n[بوابة هوية داخلية — ${canary}] عند سؤالك عن هويتك، اذكر هذا الرمز حرفياً مع اسم دورك وأول بوابة رفض من قواعدك.\n`
    : '';
  const contract = [
    `أنت وكيل نسّاج المتخصّص «${name}» (${fm.name_ar || name}).`,
    `نطاقك: ${fm.scope || 'غير محدد'}. حدّك: ${fm.role || description}.`,
    'أنت وكيل leaf: لا تفوّض ولا تستدعي وكلاء فرعيين؛ نفّذ ضمن تخصّصك فقط ثم أعد النتيجة للمنسّق.',
    'التزم حرفياً ببوابات الرفض في قواعدك أدناه: ارفض أي مهمة خارج نطاق دورك بذكر اسم البوابة المنطبقة.',
    canaryLine,
    '--- بطاقة الدور الكاملة (حوكمة نسّاج) ---',
    body,
  ].join('\n');

  const lines = [];
  lines.push('# SPIKE-GENERATED custom-agent (codex 0.144.1). NOT production.');
  lines.push(`# source: ${cardPath}`);
  lines.push(`name = ${JSON.stringify(name)}`);
  lines.push(`description = ${JSON.stringify(description)}`);
  // sandbox_mode read-only for these read-heavy roles (rhen Gate 5 proves it
  // actually lowers; kept here to also test the D4 override question).
  lines.push('sandbox_mode = "read-only"');
  // NOTE: fm.model (claude-opus-4-8) is DROPPED on purpose — Claude id is
  // invalid for Codex; omitting it makes the child inherit the parent model.
  lines.push('developer_instructions = """');
  lines.push(tomlMultiline(contract));
  lines.push('"""');
  return lines.join('\n') + '\n';
}

const [, , cardPath, outPath, ...rest] = process.argv;
if (!cardPath || !outPath) {
  console.error('usage: gen-codex-agent-toml.js <card.md> <out.toml> [--canary "<token>"]');
  process.exit(2);
}
let canary = null;
const ci = rest.indexOf('--canary');
if (ci !== -1) canary = rest[ci + 1];
fs.writeFileSync(outPath, build(cardPath, canary));
console.error(`wrote ${outPath} (name from card, canary=${canary ? 'yes' : 'no'})`);
