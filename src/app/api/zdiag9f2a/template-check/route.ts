import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'

// TEMPORARY diagnostic route — deleted right after use.
// Fetches the live template definition straight from Meta (ground truth)
// to compare against our local message_templates mirror, which may be stale.
const DEBUG_SECRET = 'tmp-diag-8f2a91cd4e'

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get('secret')
  if (secret !== DEBUG_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = supabaseAdmin()
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('waba_id, access_token')
    .limit(1)
    .single()

  if (!config?.waba_id || !config?.access_token) {
    return NextResponse.json({ error: 'no config' }, { status: 404 })
  }

  const accessToken = decrypt(config.access_token)
  const url = `https://graph.facebook.com/v21.0/${config.waba_id}/message_templates?name=magic_link_url&fields=name,language,status,category,components`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const body = await res.json()

  return NextResponse.json(body)
}
