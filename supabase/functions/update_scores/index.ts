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
  const params = new URLSearchParams(initData)
  const hash = params.get("hash") || ""
  params.delete("hash")
  // Удаляем signature - оно не участвует в проверке
  params.delete("signature")

  const pairs: string[] = []
  for (const [k, v] of Array.from(params.entries()).sort()) {
    pairs.push(`${k}=${v}`)
  }
  const dataCheckString = pairs.join("\n")

  console.log('[verifyTelegramInitData] hash from Telegram:', hash)
  console.log('[verifyTelegramInitData] dataCheckString:', dataCheckString.substring(0, 200))

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

    // Full cryptographic verification
    console.log('[update_scores] Verifying Telegram initData...')
    const ok = await verifyTelegramInitData(initData, botToken)
    if (!ok) {
      console.error('[update_scores] Telegram verification FAILED')
      return new Response(JSON.stringify({ error: "Invalid Telegram signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }
    console.log('[update_scores] Telegram verification OK')

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
    const { error: upsertErr } = await admin
      .from("leaderboard")
      .upsert(record, { onConflict: "telegram_id" })
      .select()

    if (upsertErr) {
      console.error('[update_scores] Upsert error:', upsertErr)
      return new Response(JSON.stringify({ error: upsertErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    console.log('[update_scores] Success!')
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
