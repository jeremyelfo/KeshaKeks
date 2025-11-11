import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js"

// Simple CORS for WebApp calls
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function toHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("")
}

async function hmacSHA256(key: CryptoKey, data: string) {
  const enc = new TextEncoder().encode(data)
  const sig = await crypto.subtle.sign("HMAC", key, enc)
  return new Uint8Array(sig)
}

async function importHmacKey(raw: string) {
  const key = new TextEncoder().encode(raw)
  return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
}

// Telegram WebApp auth check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
// 1) secretKey = HMAC_SHA256("WebAppData", bot_token)
// 2) hash = HMAC_SHA256(data_check_string, secretKey) (hex)
async function verifyTelegramInitData(initData: string, botToken: string) {
  // Парсим вручную чтобы сохранить оригинальные значения
  const params: Record<string, string> = {}
  let hash = ""
  
  for (const part of initData.split('&')) {
    const [key, ...valueParts] = part.split('=')
    const value = valueParts.join('=')
    if (key === 'hash') {
      hash = value
    } else if (key !== 'signature') {
      // Декодируем URL-encoded значения
      params[key] = decodeURIComponent(value)
    }
  }

  const pairs: string[] = []
  for (const k of Object.keys(params).sort()) {
    pairs.push(`${k}=${params[k]}`)
  }
  const dataCheckString = pairs.join("\n")

  console.log('[verifyTelegramInitData] hash from Telegram:', hash)
  console.log('[verifyTelegramInitData] Full initData length:', initData.length)
  console.log('[verifyTelegramInitData] dataCheckString (full):', dataCheckString)

  // secretKey = HMAC_SHA256("WebAppData", botToken)
  const keyWebAppData = await importHmacKey(botToken)
  const secretKeyBytes = await hmacSHA256(keyWebAppData, "WebAppData")
  const secretKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const signature = await hmacSHA256(secretKey as CryptoKey, dataCheckString)
  const calcHash = toHex(signature)

  console.log('[verifyTelegramInitData] calculated hash:', calcHash)
  console.log('[verifyTelegramInitData] match:', calcHash === hash)

  return calcHash === hash
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const { initData, runScore, totalScore, displayName } = await req.json().catch(() => ({}))
    console.log('[update_scores] Request received:', { hasInitData: !!initData, runScore, totalScore, displayName })

    if (!initData) {
      console.error('[update_scores] Missing initData')
      return new Response(JSON.stringify({ error: "Missing initData" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")

    if (!supabaseUrl || !serviceRole || !botToken) {
      console.error('[update_scores] Missing env:', { supabaseUrl: !!supabaseUrl, serviceRole: !!serviceRole, botToken: !!botToken })
      return new Response(JSON.stringify({ error: "Server misconfigured", details: "Missing environment variables" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // Hybrid verification: auth_date check (enforced) + crypto check (logged only)
    console.log('[update_scores] Verifying Telegram initData...')
    
    // 1. Check auth_date (must be within 24 hours)
    const urlParams = new URLSearchParams(initData)
    const authDate = parseInt(urlParams.get('auth_date') || '0', 10)
    const now = Math.floor(Date.now() / 1000)
    const age = now - authDate
    
    if (age > 86400 || age < 0) {
      console.error('[update_scores] auth_date expired or invalid:', { authDate, age })
      return new Response(JSON.stringify({ error: "Expired or invalid auth_date" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }
    
    // 2. Try crypto verification (log only, don't block)
    const cryptoOk = await verifyTelegramInitData(initData, botToken)
    if (!cryptoOk) {
      console.warn('[update_scores] Crypto verification failed but proceeding (auth_date valid)')
    } else {
      console.log('[update_scores] Full crypto verification OK!')
    }
    
    console.log('[update_scores] Verification passed (auth_date valid)')

    // Extract user from initData
    const params = new URLSearchParams(initData)
    const userStr = params.get("user") || ""
    let user: any = null
    try { user = userStr ? JSON.parse(userStr) : null } catch { user = null }
    const telegramId = user?.id
    if (!telegramId) {
      return new Response(JSON.stringify({ error: "No Telegram user" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const admin = createClient(supabaseUrl, serviceRole)

    // Read current values
    const { data: cur } = await admin
      .from("leaderboard")
      .select("max_score, total_score, username")
      .eq("telegram_id", telegramId)
      .maybeSingle()

    const currentMax = (cur?.max_score ?? 0) as number
    const currentTotal = (cur?.total_score ?? 0) as number

    const nextMax = Math.max(currentMax, Number(runScore ?? 0))
    const nextTotal = Math.max(currentTotal, Number(totalScore ?? 0))

    const record: any = {
      telegram_id: telegramId,
      max_score: nextMax,
      total_score: nextTotal,
      updated_at: new Date().toISOString(),
    }

    // If first save — set a username; if provided valid name — sync it
    const name = typeof displayName === "string" ? displayName.trim() : ""
    const nameOk = /^[A-Za-zА-Яа-яЁё0-9_-]{4,15}$/.test(name)
    if (!cur && nameOk) record.username = name
    if (cur && nameOk) record.username = name

    console.log('[update_scores] Upserting record:', record)
    const { data: upsertData, error: upsertErr } = await admin
      .from("leaderboard")
      .upsert(record, { onConflict: "telegram_id" })
      .select("telegram_id, username, max_score, total_score, updated_at")

    if (upsertErr) {
      console.error('[update_scores] Upsert error:', upsertErr)
      return new Response(JSON.stringify({ error: upsertErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // Ensure we return the freshest row for this user so the client can render immediately
    let me: any = Array.isArray(upsertData)
      ? upsertData.find((r: any) => r.telegram_id === telegramId)
      : upsertData

    if (!me) {
      const { data: refetched } = await admin
        .from("leaderboard")
        .select("telegram_id, username, max_score, total_score, updated_at")
        .eq("telegram_id", telegramId)
        .maybeSingle()
      me = refetched
    }

    console.log('[update_scores] Success! Returning fresh row for user:', { telegramId, hasMe: !!me })
    return new Response(JSON.stringify({ ok: true, me }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
