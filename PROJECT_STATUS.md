# حالة المشروع — nassaj-dev

> آخر تحديث: 2026-05-24

## الحالة الراهنة
✅ جميع المراحل (0→4) مكتملة. nassaj-dev.alkindy.tech جاهز للاختبار.

## شرط الانتقال للنسخة الرئيسية
- [ ] agy يعمل E2E بدون أخطاء (chat, history, abort) — **اختبر يدوياً**
- [ ] RTL يعمل في sidebar/chat/settings بدون كسر بصري — **اختبر يدوياً**
- [ ] لا regression على Claude provider — **اختبر يدوياً**
- [ ] ≥10 جلسات حقيقية على nassaj-dev بدون مشاكل حرجة — **يحتاج وقتاً**

## المراحل المكتملة

### Phase 0 — Foundation ✅
| B-01 | fork + clone | Kindi-sa/nassaj-dev (private, AGPL-3.0) |
| B-02 | package.json | name=nassaj-dev, homepage=nassaj-dev.alkindy.tech |
| B-03 | LLMProvider union | 'antigravity' في 10 ملفات |
| B-04 | PM2 ecosystem | port 3004, DATABASE_PATH مستقل |
| B-05 | Cloudflare tunnel | nassaj-dev.alkindy.tech → 127.0.0.1:3004 |

### Phase 1 — AntigravityProvider Backend ✅
| B-10 | agy-cli.js | spawn agy -p, streaming حقيقي, SIGTERM/SIGKILL |
| B-11 | antigravity-auth | فحص وجود agy + brain dir |
| B-12 | antigravity-sessions | transcript.jsonl parser |
| B-13 | antigravity-session-synchronizer | scan brain/<UUID>/ → DB |
| B-14 | antigravity-skills | stub فارغ |
| B-15 | antigravity-mcp | stub (agy عميل MCP لا خادم) |
| B-16 | antigravity.provider | Composition Root |
| B-17 | provider.registry | تسجيل AntigravityProvider |
| C-18 | chat-websocket | antigravity-command dispatch |
| C-19 | notification-orchestrator | PDPL audit log (M-56) |
| C-20 | abort logic | SIGTERM + SIGKILL بعد 5s |

### Phase 2 — Frontend Integration ✅
| C-30 | Provider selector | Antigravity (agy), ⚡ logo, emerald theme |
| C-31 | Auth badge | Connected/Disconnected via auth/status API |
| C-32 | Settings tab | CLI instructions + model info |
| C-33 | History view | generalized pipeline — لا تغيير مطلوب |
| C-34 | Sub-agent badge | Task tool_use → purple "Sub-agent" pill |

### Phase 3 — RTL Arabic ✅
| B-40 | Locale ar | 7 namespaces عربية |
| B-41 | languages.js | ar مع dir: 'rtl' |
| B-42 | i18n config | استيراد ترجمات ar |
| B-43 | RTL toggle | Appearance Settings → "RTL Layout" (مستقل عن اللغة) |
| B-44 | tailwindcss-rtl | مثبّت ومُفعَّل |
| C-45 | خطوط Tajawal | من Google Fonts، تُطبَّق عند dir=rtl |
| C-46 | LTR صريح | code editor, terminal, git diff, file paths |

### Phase 4 — Hardening ✅
| M-50 | Unit tests auth | 7 اختبار |
| M-51 | Integration test sync | 9 اختبار |
| M-53 | Schema snapshot | 13 اختبار |
| M-54 | Exit code handling | رسائل خطأ واضحة لكل كود |
| M-55 | Rate limiting | 60 req/min/IP على /api/providers/antigravity/ |
| M-56 | Audit log PDPL | metadata فقط (sessionId, exitCode, timestamp) |

**إجمالي: 29/29 اختبار ناجح**

## البيئة
- URL: https://nassaj-dev.alkindy.tech
- Port: 3004, PM2: nassaj-dev
- DB: /home/nassaj/.local/share/nassaj-dev/db.sqlite
- GitHub: Kindi-sa/nassaj-dev (private, AGPL-3.0)

## ملاحظات مهمة
- **AGPL-3.0**: أي نشر خارجي يستلزم إتاحة الكود (نسّق مع legal-compliance-advisor)
- **RTL**: اختياري من Appearance Settings → RTL Layout toggle
- **project_path لـ agy sessions**: placeholder `/__antigravity__` — لا يمكن تحديد workspace بسهولة من transcript
- **agy TTFB**: ~8 ثوانٍ طبيعي — loading indicator مطلوب في UX

## القرارات المفتوحة
- [ ] AGPL-3.0 compliance review
- [ ] antigravity sessions في per-project sidebar (تحتاج تعديل session-fetch service)
- [ ] agy model selector في Settings (حالياً يستخدم نموذج agy الافتراضي)
- [ ] RTL audit بصري كامل (C-47 — اختبار يدوي)
