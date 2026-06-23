#!/usr/bin/env bash
# =============================================================================
# netns-egress-allowlist.sh  —  Track B egress hardening (REVIEW-ONLY DRAFT)
# -----------------------------------------------------------------------------
# الغرض: إنشاء network namespace اسمه 'nassaj-egress' بسياسة egress افتراضيّتها
#        DROP و allowlist يسمح فقط بنطاقات المزوّدين الضرورية + loopback +
#        منفذ التطبيق المحلي 3004 + نفق Tailscale + DNS عبر Tailscale MagicDNS.
#
# ⛔ هذا السكربت مسوّدة للمراجعة فقط — لا يُنفَّذ إلا بموافقة المالك الصريحة.
#    يتطلّب صلاحية root. كل سطر يحتاج root مُعلَّم بـ  # [ROOT].
#    لا يُطبَّق شيء تلقائياً؛ راجِع كل القواعد قبل التشغيل (انظر OWNER-STEPS.md).
#
# المضيف المستهدف: nassaj (Debian 13 Trixie). حقائق مؤكَّدة بقراءة حيّة:
#   - kernel.unprivileged_userns_clone = 1 (userns غير متميّزة مدعومة)؛
#     ومع ذلك نُنشئ veth/netns كـ root للاستقرار والوضوح.
#   - DNS = Tailscale MagicDNS 100.100.100.100 (/etc/resolv.conf مُولَّد من tailscale).
#   - IP نفق Tailscale لهذا الجهاز = 100.105.15.51 (CGNAT 100.64.0.0/10).
#   - التطبيق يستمع 127.0.0.1:3004 (PM2 nassaj-dev).
#   - nft و iptables مثبَّتان لكن في /usr/sbin+/sbin وليسا في PATH الافتراضي
#     → نستخدم مسارات مطلقة. iptables هنا backend=nft، لكننا نستعمل nft مباشرة.
#
# ملاحظة جوهرية حول استقرار النطاقات: عناوين IP للمزوّدين **تتغيّر** (CDN/anycast).
# allowlist بعناوين IP ثابتة سيكسِر الوصول عند دوران العناوين. الحل المُوصى به:
#   forward-proxy للـ egress (tinyproxy/squid) داخل أو بجوار الـ netns يسمح بـ ~5
#   نطاقات فقط بالاسم (SNI/Host)، فيتولّى هو حلّ DNS والاتصال، وتبقى قاعدة الـ netns
#   تسمح فقط بالاتصال بالـ proxy. انظر القسم (G) في الأسفل.
#   ⚠️ استثناء مهم: **لا تضبط أي متغيّر proxy على بيئة Claude الخاصة بـ Body-1**
#   (أي لا HTTPS_PROXY/HTTP_PROXY على عملية claude التي تتصل بـ api.anthropic.com).
#   اسمح لـ api.anthropic.com مباشرةً (القسم D) كي لا يمرّ ترافيك Anthropic عبر proxy.
# =============================================================================

set -euo pipefail

# ----- مسارات مطلقة (الأدوات ليست في PATH الافتراضي) -------------------------
IP=/usr/sbin/ip                 # موجود في /usr/bin/ip أيضاً؛ /usr/sbin/ip آمن كـ root
NFT=/usr/sbin/nft               # nftables 1.1.3
GETENT=/usr/bin/getent
# fallback إن اختلف مسار ip:
[ -x "$IP" ]  || IP=/usr/bin/ip
[ -x "$NFT" ] || NFT=/sbin/nft

# ----- ثوابت الإعداد ----------------------------------------------------------
NETNS=nassaj-egress
VETH_HOST=veth-nsh             # طرف veth في host namespace
VETH_NS=veth-nsg               # طرف veth داخل الـ netns
HOST_ADDR=10.200.200.1         # عنوان host على رابط veth (/30 خاص)
NS_ADDR=10.200.200.2           # عنوان الـ netns على رابط veth
PREFIX=30
APP_PORT=3004                  # منفذ nassaj-dev (loopback)
TS_RESOLVER=100.100.100.100    # Tailscale MagicDNS
TS_CGNAT=100.64.0.0/10         # نطاق Tailscale (يشمل 100.105.15.51)

# نطاقات المزوّدين المسموح بها (allowlist بالاسم — تُحَل عبر MagicDNS وقت الإعداد).
# تُستخدم لاشتقاق عناوين IP الحالية؛ راجِع تحذير دوران العناوين أعلاه واعتمد proxy للإنتاج.
ALLOW_DOMAINS=(
  api.anthropic.com                       # Body-1 Claude — مباشرة، بلا proxy
  api.moonshot.cn                         # Moonshot/Kimi
  api.deepseek.com                        # DeepSeek (يُبلَغ عبر opencode؛ مُدرَج احتياطاً)
  generativelanguage.googleapis.com       # Gemini
  oauth2.googleapis.com                   # Gemini OAuth
  daily-cloudcode-pa.googleapis.com       # agy / Antigravity
  cloudcode-pa.googleapis.com             # agy / Antigravity (catalog)
  api.github.com                          # GitHub API
)

# =============================================================================
# (A) فحوصات مُسبقة (root)
# =============================================================================
[ "$(id -u)" -eq 0 ] || { echo "FATAL: يجب التشغيل كـ root." >&2; exit 1; }   # [ROOT]
echo "[*] netns موجود؟ تنظيف أي بقايا سابقة بنفس الاسم…"
if "$IP" netns list 2>/dev/null | grep -qw "$NETNS"; then                     # [ROOT]
  echo "    موجود — احذفه يدوياً أولاً إن أردت إعادة الإنشاء:"
  echo "      $IP netns del $NETNS   # [ROOT]"
  echo "    (نتوقّف هنا لتجنّب تدمير حالة قائمة)"; exit 1
fi

# =============================================================================
# (B) إنشاء الـ netns ورابط veth (root)
# =============================================================================
"$IP" netns add "$NETNS"                                                      # [ROOT]
"$IP" link add "$VETH_HOST" type veth peer name "$VETH_NS"                    # [ROOT]
"$IP" link set "$VETH_NS" netns "$NETNS"                                      # [ROOT]

# عنونة طرف الـ host
"$IP" addr add "${HOST_ADDR}/${PREFIX}" dev "$VETH_HOST"                      # [ROOT]
"$IP" link set "$VETH_HOST" up                                               # [ROOT]

# عنونة وتفعيل داخل الـ netns (loopback + veth + default route عبر host)
"$IP" -n "$NETNS" addr add "${NS_ADDR}/${PREFIX}" dev "$VETH_NS"             # [ROOT]
"$IP" -n "$NETNS" link set lo up                                            # [ROOT]
"$IP" -n "$NETNS" link set "$VETH_NS" up                                    # [ROOT]
"$IP" -n "$NETNS" route add default via "$HOST_ADDR"                         # [ROOT]

# =============================================================================
# (C) NAT + forwarding على المضيف لرابط الـ veth (root)
#     يسمح للترافيك المسموح به (بعد فلترة الـ netns) بالخروج عبر واجهة المضيف.
#     ملاحظة: UFW على المضيف Outgoing=Allow؛ الفلترة الفعّالة هنا في OUTPUT داخل الـ netns.
# =============================================================================
echo 1 > /proc/sys/net/ipv4/ip_forward                                       # [ROOT]
# MASQUERADE لمصدر الـ netns فقط (لا نلمس قواعد المضيف الأخرى):
"$NFT" add table ip nassaj_egress_nat 2>/dev/null || true                     # [ROOT]
"$NFT" -- add chain ip nassaj_egress_nat postrouting \
  '{ type nat hook postrouting priority 100 ; }' 2>/dev/null || true          # [ROOT]
"$NFT" add rule ip nassaj_egress_nat postrouting \
  ip saddr "${NS_ADDR}/${PREFIX}" masquerade                                  # [ROOT]

# =============================================================================
# (D) سياسة الـ egress داخل الـ netns: default-DROP + allowlist (root)
#     كل أوامر nft التالية تُنفَّذ *داخل* الـ netns عبر `ip netns exec`.
#     OUTPUT افتراضيّته DROP؛ نسمح صراحةً فقط بما يلي.
# =============================================================================
NSX=("$IP" netns exec "$NETNS")   # بادئة التنفيذ داخل الـ netns

# جدول وسلاسل بسياسة DROP افتراضية على output (والإبقاء على input/forward مضبوطة)
"${NSX[@]}" "$NFT" add table inet fw                                           # [ROOT]
"${NSX[@]}" "$NFT" add chain inet fw output \
  '{ type filter hook output priority 0 ; policy drop ; }'                     # [ROOT]
"${NSX[@]}" "$NFT" add chain inet fw input \
  '{ type filter hook input priority 0 ; policy drop ; }'                      # [ROOT]

# (D.1) loopback داخل الـ netns — مسموح بالكامل (التطبيق + IPC المحلي)
"${NSX[@]}" "$NFT" add rule inet fw output oif lo accept                        # [ROOT]
"${NSX[@]}" "$NFT" add rule inet fw input  iif lo accept                        # [ROOT]

# (D.2) الردود على الجلسات القائمة
"${NSX[@]}" "$NFT" add rule inet fw output ct state established,related accept   # [ROOT]
"${NSX[@]}" "$NFT" add rule inet fw input  ct state established,related accept   # [ROOT]

# (D.3) منفذ التطبيق المحلي 127.0.0.1:3004 (يصله العميل عبر loopback؛ مغطّى بـ D.1،
#       ونؤكّده صراحةً لمنفذ 3004 لتوثيق النية)
"${NSX[@]}" "$NFT" add rule inet fw output ip daddr 127.0.0.1 tcp dport ${APP_PORT} accept  # [ROOT]

# (D.4) Tailscale: المُحلِّل MagicDNS + نطاق النفق بالكامل (DNS عبر 100.100.100.100 فقط)
"${NSX[@]}" "$NFT" add rule inet fw output ip daddr ${TS_RESOLVER} udp dport 53 accept       # [ROOT]
"${NSX[@]}" "$NFT" add rule inet fw output ip daddr ${TS_RESOLVER} tcp dport 53 accept       # [ROOT]
"${NSX[@]}" "$NFT" add rule inet fw output ip daddr ${TS_CGNAT} accept                       # [ROOT]
#   ^ يسمح بالوصول إلى 127.0.0.1:3004 المنشور أيضاً عبر نفق Tailscale (100.105.15.51)
#     ولأي خدمة tailnet لازمة. ضيِّقه إلى /32 لاحقاً إن أردت تشديداً أكبر.

# (D.5) allowlist المزوّدين — بالاسم مُحَلاً وقت الإعداد إلى IPs الحالية.
#       ⚠️ العناوين تتغيّر — هذا حلّ مرحلي؛ للإنتاج استخدم proxy (القسم G).
echo "[*] حلّ نطاقات المزوّدين عبر Tailscale MagicDNS وإضافتها للـ allowlist…"
for d in "${ALLOW_DOMAINS[@]}"; do
  # نستعمل getent على المضيف (DNS=MagicDNS) لاشتقاق IPv4 الحالية:
  ips="$("$GETENT" ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  if [ -z "$ips" ]; then
    echo "    تحذير: تعذّر حلّ $d الآن — تَخطّيه (سيُحجب حتى يُحَل/يُضاف عبر proxy)."
    continue
  fi
  for ip in $ips; do
    "${NSX[@]}" "$NFT" add rule inet fw output ip daddr "$ip" tcp dport 443 accept   # [ROOT]
    echo "    + $d -> $ip :443"
  done
done

# (D.6) أي شيء آخر يسقط بحكم policy drop (لا قاعدة سماح إضافية).
echo "[*] سياسة الـ egress داخل '$NETNS': default-DROP + allowlist مطبّقة."

# =============================================================================
# (E) عرض القواعد للمراجعة (للقراءة فقط — لكن داخل netns يلزم root)
# =============================================================================
echo "----- nft ruleset داخل $NETNS -----"
"${NSX[@]}" "$NFT" list ruleset                                                # [ROOT]
echo "-----------------------------------"

cat <<'EOF'

[✓] انتهى إنشاء الـ netns (مسوّدة). لإلحاق عملية التطبيق بهذا الـ netns،
    شغّلها عبر:  ip netns exec nassaj-egress <command>          # [ROOT]
    (التفاصيل والـ canary في OWNER-STEPS.md)

[إزالة كاملة عند الحاجة]   # [ROOT] لكل سطر:
    ip netns del nassaj-egress
    ip link del veth-nsh            2>/dev/null || true
    nft delete table ip   nassaj_egress_nat 2>/dev/null || true
EOF

# =============================================================================
# (G) موصى به للإنتاج: forward-proxy للـ egress (tinyproxy/squid)
# -----------------------------------------------------------------------------
# لأن IPs المزوّدين تدور، الـ allowlist بالعناوين (D.5) يحتاج تحديثاً دورياً ويكسِر
# عند الدوران. البديل المتين:
#
#   1) شغّل tinyproxy (أو squid) يستمع على ${HOST_ADDR}:8888 في host namespace،
#      بـ allowlist نطاقات (Filter/FilterDefaultDeny في tinyproxy) لـ ~5 نطاقات فقط:
#         api.moonshot.cn  api.deepseek.com  generativelanguage.googleapis.com
#         cloudcode-pa.googleapis.com  api.github.com
#      (الـ proxy يحلّ DNS ويتصل؛ فلا حاجة لتثبيت IPs في الـ netns.)
#
#   2) في الـ netns: استبدل قواعد (D.5) بقاعدة واحدة تسمح بالاتصال بالـ proxy فقط:
#         nft add rule inet fw output ip daddr ${HOST_ADDR} tcp dport 8888 accept   # [ROOT]
#      وعرِّف للعمليات (عدا claude الخاصة بـ Anthropic):
#         HTTPS_PROXY=http://${HOST_ADDR}:8888  HTTP_PROXY=http://${HOST_ADDR}:8888
#
#   3) ⛔ استثناء Body-1 Claude: لا تضبط HTTPS_PROXY/HTTP_PROXY على عملية claude
#      التي تتصل بـ api.anthropic.com. أبقِ api.anthropic.com مسموحاً مباشرةً في الـ
#      netns (قاعدة D.5 الخاصة به فقط، أو NO_PROXY=api.anthropic.com على تلك العملية).
#      الهدف: ترافيك Anthropic لا يمرّ عبر أي proxy وسيط.
#
# هذا القسم توثيقي فقط — لا يُنشئ proxy. اعتمده عند الانتقال من المرحلي إلى الإنتاج.
# =============================================================================
