import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import Stripe from 'stripe'

const app = new Hono()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

// ヘルスチェック
app.get('/health', (c) => c.json({ status: 'ok' }))

// SetupIntent作成（カード登録用）
app.post('/v1/stripe/setup-intent', async (c) => {
  const { userId } = await c.req.json()
  if (!userId) return c.json({ error: 'userId is required' }, 400)

  try {
    const existing = await stripe.customers.search({
      query: `metadata['userId']:'${userId}'`,
      limit: 1
    })

    let customer
    if (existing.data.length > 0) {
      customer = existing.data[0]
    } else {
      customer = await stripe.customers.create({ metadata: { userId } })
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { userId }
    })

    return c.json({
      clientSecret: setupIntent.client_secret,
      customerId: customer.id
    })
  } catch (err) {
    console.error('Setup intent error:', err)
    return c.json({ error: 'Failed to create setup intent' }, 500)
  }
})

// Webhook
app.post('/v1/stripe/webhook', async (c) => {
  const signature = c.req.header('stripe-signature')
  const body = await c.req.text()

  let event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    return c.json({ error: 'Invalid signature' }, 400)
  }

  switch (event.type) {
    case 'setup_intent.succeeded': {
      const si = event.data.object
      console.log(`Card registered: customer=${si.customer}, pm=${si.payment_method}`)
      break
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object
      console.log(`Payment succeeded: ${pi.id}, date=${pi.metadata.dateString}`)
      break
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object
      console.log(`Payment failed: ${pi.id}, reason=${pi.last_payment_error?.message}`)
      break
    }
  }

  return c.json({ received: true })
})

// 日次判定・寄付処理（毎日JST 00:00にCronから呼ぶ）
app.post('/internal/daily-judgment', async (c) => {
  const token = c.req.header('x-internal-token')
  if (token !== process.env.INTERNAL_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  console.log('Daily judgment started')
  return c.json({ status: 'ok' })
})

serve({ fetch: app.fetch, port: process.env.PORT || 3000 })
console.log('FocusBet API started')
