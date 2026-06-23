# Phase 0 — Foundation ✅

**الحالة:** مكتملة — 2026-05-24  
**المسؤول:** منسّق + devops + backend-dev

> **حاشية (2026-06-15):** الدومين `nassaj-dev.alkindy.tech` المذكور أدناه (homepage في B-02 ونفق Cloudflare في B-05) **تقاعد**؛ الوصول الحيّ الآن عبر `https://nassaj.alkindy.tech` (نفس نفق Cloudflare → `127.0.0.1:3004`). تُركت قيم المرحلة التاريخية كما سُجّلت.

## Work Items

### B-01: Fork + Clone ✅
- fork: Kindi-sa/nassaj-dev (private) من siteboon/claudecodeui
- clone: /home/nassaj/Project/nassaj-dev/
- **تنبيه:** الترخيص AGPL-3.0 يستلزم إتاحة الكود عند أي نشر خارجي

### B-02: package.json ✅
- name: nassaj-dev
- homepage: https://nassaj-dev.alkindy.tech
- description: nassaj-dev — claudecodeui fork with AntigravityProvider and RTL Arabic support

### B-03: LLMProvider union ✅
الملفات المعدّلة (10 ملفات):
- server/shared/types.ts
- src/types/app.ts
- server/modules/providers/services/session-synchronizer.service.ts
- src/components/provider-auth/types.ts
- src/components/mcp/constants.ts
- src/components/settings/view/tabs/agents-settings/sections/AgentSelectorSection.tsx
- src/components/settings/view/tabs/agents-settings/AgentListItem.tsx
- src/components/settings/view/tabs/agents-settings/sections/content/AccountContent.tsx
- src/components/settings/view/tabs/agents-settings/AgentsSettingsTab.tsx
- src/components/chat/view/subcomponents/ProviderSelectionEmptyState.tsx (TS fix)
- server/modules/providers/provider.registry.ts (Partial<Record<...>>)

### B-04: PM2 Ecosystem ✅
- الملف: ecosystem.config.cjs (وليس .js — بسبب "type":"module" في package.json)
- Port: 3004 (وليس 3002 — محجوز لـ wafeq-connect-ui)
- DATABASE_PATH + NASSAJ_DB_PATH: /home/nassaj/.local/share/nassaj-dev/db.sqlite
- script: dist-server/server/index.js

### B-05: Cloudflare Tunnel ✅
- أُضيف: nassaj-dev.alkindy.tech → http://127.0.0.1:3004
- DNS CNAME: nassaj-dev.alkindy.tech → fbf87d59...cfargotunnel.com
- Backup: ~/.cloudflared/config.yml.bak.20260524-192702
- Rollback: `cp ~/.cloudflared/config.yml.bak.20260524-192702 ~/.cloudflared/config.yml && systemctl --user restart cloudflared`

## القرارات التقنية في هذه المرحلة

**تغيير Port من 3002 إلى 3004:**
اكتُشف أن 3002 محجوز لـ `wafeq-connect-ui` (Docker). استبدلنا بـ 3004 (حر).

**ecosystem.config.cjs لا .js:**
package.json يحتوي "type":"module" مما يجعل .js يُفسَّر كـ ESM. PM2 يستخدم require() لملفات ecosystem.

**Cloudflared user-mode:**
أمر restart الصحيح: `systemctl --user restart cloudflared` (لا sudo).

**DATABASE_PATH + NASSAJ_DB_PATH:**
الكود يقرأ DATABASE_PATH فعلياً. NASSAJ_DB_PATH مُمرَّر للتوثيق فقط.
