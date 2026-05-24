# حالة المشروع — nassaj-dev

> آخر تحديث: 2026-05-24

## الحالة الراهنة
🟡 Phase 0 مكتملة، Phase 1 لم تبدأ بعد.

## المرحلة الحالية: Phase 1 — AntigravityProvider Backend

### الخطوة التالية الفورية
**B-10:** تنفيذ server/agy-cli.js وتحقق من streaming:
- هل `agy -p` يدعم streaming حقيقي (SIGTERM للأحرف بمجرد وصولها) أم buffered (ينتظر اكتمال الجواب)؟
- إن لم يدعم streaming: رفع m-60 (PTY) إلى Blocking قبل المتابعة.

## Phase 0 — مكتملة ✅
| Work Item | الحالة | ملاحظات |
|-----------|--------|---------|
| B-01: fork + clone | ✅ | Kindi-sa/nassaj-dev (private) |
| B-02: package.json | ✅ | name=nassaj-dev, homepage=nassaj-dev.alkindy.tech |
| B-03: LLMProvider union | ✅ | 10 ملفات + TS fix في ProviderSelectionEmptyState |
| B-04: PM2 ecosystem | ✅ | port 3004, DATABASE_PATH مستقل |
| B-05: Cloudflare tunnel | ✅ | nassaj-dev.alkindy.tech → 127.0.0.1:3004 |

## القرارات المفتوحة
- [ ] AGPL-3.0 compliance: تنسيق مع legal-compliance-advisor قبل أي نشر خارجي
- [ ] port 3004: تأكيد لا تعارض مستقبلي مع خدمات Docker جديدة

## ملاحظات بيئية
- Port: 3004 (وليس 3002 — محجوز لـ wafeq-connect-ui)
- Cloudflared: user-mode (`systemctl --user restart cloudflared`)
- DB: /home/nassaj/.local/share/nassaj-dev/db.sqlite (مستقل)
- npm install: يستلزم `--ignore-scripts` أو `--include=dev` في بيئة production NODE_ENV
