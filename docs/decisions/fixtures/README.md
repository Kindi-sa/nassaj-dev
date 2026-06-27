# Fixtures — اختبار التثبيت والصيغ (Test Fixtures)

هذا المجلد يحوي نماذج اختبار (fixtures) لتثبيت توقّعات الصيغ والسلوكيات المعمارية عبر الترقيات والتغييرات.

## الملفات

### journal-completed.jsonl
**الغرض:** اختبار تثبيت صيغة `journal.jsonl` لـ Claude Code SDK workflows.

**الصيغة المتوقعة:**
```jsonl
{"type":"started","key":"<hash>","agentId":"<id>","timestamp":<ms>}
{"type":"result","key":"<hash>","agentId":"<id>","result":{"sectionId":<id>,"title":<str>,"content":<str>},"timestamp":<ms>}
```

**المصدر:** حادثة wf_ef5ba242-b4b (2026-06-27) — نموذج مختصر يحاكي سلوك workflow مكتمل.

**الاستخدام:**
```bash
# اختبار reconciliation
npm run test -- workflow-reconcile.service.spec.ts \
  --fixture docs/decisions/fixtures/journal-completed.jsonl
```

**التحقّق:**
- يجب أن يكتشف الخدمة اكتمال العمل (`count(started)==count(result)`)
- يجب أن لا تطرح (fail-safe)
- يجب أن تُرجع رسالة task_reconcile مشتقّة

## المحافظ عليها (Regression Testing)

**القاعدة الحديدية:** أي ترقية upstream تُغيّر:
- أسماء الحقول (`type`, `key`, `result`)
- صيغة المفاتيح
- هيكل `result` الداخلي

**يجب** أن تفشل اختبارات اللاحقة إلى أن يُحدّث الـfixture والخدمة.

## الإضافات المستقبلية

- `journal-partial.jsonl` — workflow معلّق (started بلا result)
- `journal-malformed.jsonl` — سطور تالفة (اختبار fail-safe)
- `journal-timeout.jsonl` — workflow قديم جداً (اختبار الهدوء)

---

**آخر تحديث:** 2026-06-27 (scribe)  
**الصلة:** ADR-048، T-225، حادثة wf_ef5ba242-b4b
