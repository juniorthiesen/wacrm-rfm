import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { uploadMedia, type WaMediaType } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// Max file sizes enforced by Meta (bytes)
const MAX_SIZE: Record<WaMediaType, number> = {
  image:    5 * 1024 * 1024,
  audio:   16 * 1024 * 1024,
  video:   16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker:  500 * 1024,
}

const ALLOWED_MIME: Record<string, WaMediaType> = {
  'image/jpeg':  'image',
  'image/png':   'image',
  'image/webp':  'sticker',
  'audio/aac':   'audio',
  'audio/mp4':   'audio',
  'audio/mpeg':  'audio',
  'audio/amr':   'audio',
  'audio/ogg':   'audio',
  'video/mp4':   'video',
  'video/3gpp':  'video',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'text/plain':  'document',
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`media-upload:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const form = await request.formData()
    const file = form.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: 'file is required' }, { status: 400 })
    }

    const mimeType = file.type
    const mediaType = ALLOWED_MIME[mimeType]
    if (!mediaType) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mimeType}` },
        { status: 400 },
      )
    }

    if (file.size > MAX_SIZE[mediaType]) {
      return NextResponse.json(
        { error: `File too large for ${mediaType} (max ${MAX_SIZE[mediaType] / (1024 * 1024)} MB)` },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json({ error: 'WhatsApp not configured' }, { status: 400 })
    }

    const accessToken = decrypt(config.access_token)
    const fileBuffer = Buffer.from(await file.arrayBuffer())

    const mediaId = await uploadMedia({
      phoneNumberId: config.phone_number_id,
      accessToken,
      fileBuffer,
      mimeType,
      fileName: file.name,
    })

    return NextResponse.json({ media_id: mediaId, media_type: mediaType, mime_type: mimeType })
  } catch (error) {
    console.error('[whatsapp/media/upload]', error)
    return NextResponse.json({ error: 'Failed to upload media' }, { status: 500 })
  }
}
