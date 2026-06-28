import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import Stripe from 'stripe'
import pg from 'pg'

const { Pool } = pg
const app = new Hono()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_payment_method_id TEXT,
      daily_goal_seconds INTEGER DEFAULT 1800,
      penalty_amount INTEGER DEFAULT 300,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS daily_records (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_string TEXT NOT NULL,
      goal_seconds INTEGER NOT NULL,
      penalty_amount INTEGER NOT NULL,
      total_focus_seconds INTEGER DEFAULT 0,
      is_achieved BOOLEAN DEFAULT FALSE,
      is_judged BOOLEAN DEFAULT FALSE,
      charge_status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date_string)
    );
    CREATE TABLE IF NOT EXISTS charge_records (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_string TEXT NOT NULL,
      amount INTEGER NOT NULL,
      stripe_payment_intent_id TEXT,
      status TEXT DEFAULT 'pending',
      failure_reason TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, date_string)
    );
  `)
  console.log('DB initialized')
}

initDB().catch(console.error)

app.get('/health', (c) => c.json({ status: 'ok' }))

app.post('/v1/users/settings', async (c) => {
  const { userId, dailyGoalSeconds, penaltyAmount } = await c.req.json()
  if (!userId) return c.json({ error: 'userId is required' }, 400)
  try {
    await pool.query(`
      INSERT INTO users (id, daily_goal_seconds, penalty_amount)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET daily_goal_seconds = $2, penalty_amount = $3
    `, [userId, dailyGoalSeconds || 1800, penaltyAmount || 300])
    return c.json({ success: true })
  } catch (err) {
    console.error('Save settings error:', err)
    return c.json({ error: 'Failed to save settings' }, 500)
  }
})

app.post('/v1/focus/record', async (c) => {
  const { userId, dateString, totalFocusSeconds, goalSeconds, penaltyAmount } = await c.req.json()
  if (!userId) return c.json({ error: 'userId is required' }, 400)
  try {
    await pool.query(`
      INSERT INTO daily_records (user_id, date_string, goal_seconds, penalty_amount, total_focus_seconds)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, date_string) DO UPDATE SET
        total_focus_seconds = $5, goal_seconds = $3, penalty_amount = $4
    `, [userId, dateString, goalSeconds, penaltyAmount, totalFocusSeconds])
    return c.json({ success: true })
  } catch (err) {
    console.error('Record focus error:', err)
    return c.json({ error: 'Failed to record focus' }, 500)
  }
})

app.post('/v1/stripe/setup-intent', async (c) => {
  const { userId } = await c.req.json()
  if (!userId) return c.json({ error: 'userId is required' }, 400)
  try {
    const result = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId])
    let customerId = result.rows[0]?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { userId } })
      customerId = customer.id
      await pool.query(`
        INSERT INTO users (id, stripe_customer_id)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET stripe_customer_id = $2
      `, [userId, customerId])
    }
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { userId }
    })
    return c.json({ clientSecret: setupIntent.client_secret, customerId })
  } catch (err) {
    console.error('Setup intent error:', err)
    return c.json({ error: 'Failed to create setup intent' }, 500)
  }
})
app.post('/v1/stripe/webhook', async (c) => {
  const signature = c.req.header('stripe-signature')
  const body = await c.req.text()
  let event
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return c.json({ error: 'Invalid signature' }, 400)
  }
  switch (event.type) {
    case 'setup_intent.succeeded': {
      const si = event.data.object
      const userId = si.metadata.userId
      if (userId && si.payment_method) {
        await pool.query(`UPDATE users SET stripe_payment_method_id = $1 WHERE id = $2`, [si.payment_method, userId])
        console.log(`Card saved for user: ${userId}`)
      }
      break
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object
      await pool.query(`UPDATE charge_records SET status = 'charged', stripe_payment_intent_id = $1 WHERE user_id = $2 AND date_string = $3`, [pi.id, pi.metadata.userId, pi.metadata.dateString])
      break
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object
      await pool.query(`UPDATE charge_records SET status = 'failed', failure_reason = $1, retry_count = retry_count + 1 WHERE user_id = $2 AND date_string = $3`, [pi.last_payment_error?.message, pi.metadata.userId, pi.metadata.dateString])
      break
    }
  }
  return c.json({ received: true })
})

app.post('/internal/daily-judgment', async (c) => {
  const token = c.req.header('x-internal-token')
  if (token !== process.env.INTERNAL_TOKEN) return c.json({ error: 'Unauthorized' }, 401)
  const yesterday = getYesterdayJST()
  console.log(`Daily judgment for: ${yesterday}`)
  const records = await pool.query(`
    SELECT dr.*, u.stripe_customer_id, u.stripe_payment_method_id
    FROM daily_records dr
    JOIN users u ON dr.user_id = u.id
    WHERE dr.date_string = $1 AND dr.is_judged = FALSE
  `, [yesterday])
  let processed = 0
  for (const record of records.rows) {
    try {
      await processJudgment(record)
      processed++
    } catch (err) {
      console.error(`Error processing user ${record.user_id}:`, err)
    }
  }
  return c.json({ processed, date: yesterday })
})

async function processJudgment(record) {
  const isAchieved = record.total_focus_seconds >= record.goal_seconds
  await pool.query(`UPDATE daily_records SET is_achieved = $1, is_judged = TRUE WHERE user_id = $2 AND date_string = $3`, [isAchieved, record.user_id, record.date_string])
  if (isAchieved) {
    await pool.query(`UPDATE daily_records SET charge_status = 'not_required' WHERE user_id = $1 AND date_string = $2`, [record.user_id, record.date_string])
    return
  }
  if (!record.stripe_customer_id || !record.stripe_payment_method_id) {
    console.log(`No payment method for user: ${record.user_id}`)
    return
  }
  try {
    const idempotencyKey = `charge-${record.user_id}-${record.date_string}`
    const pi = await stripe.paymentIntents.create({
      amount: record.penalty_amount,
      currency: 'jpy',
      customer: record.stripe_customer_id,
      payment_method: record.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      metadata: { userId: record.user_id, dateString: record.date_string }
    }, { idempotencyKey })
    await pool.query(`
      INSERT INTO charge_records (user_id, date_string, amount, stripe_payment_intent_id, status)
      VALUES ($1, $2, $3, $4, 'charged')
      ON CONFLICT (user_id, date_string) DO UPDATE SET status = 'charged', stripe_payment_intent_id = $4
    `, [record.user_id, record.date_string, record.penalty_amount, pi.id])
    await pool.query(`UPDATE daily_records SET charge_status = 'charged' WHERE user_id = $1 AND date_string = $2`, [record.user_id, record.date_string])
  } catch (err) {
    console.error(`Charge failed for user ${record.user_id}:`, err.message)
    await pool.query(`
      INSERT INTO charge_records (user_id, date_string, amount, status, failure_reason)
      VALUES ($1, $2, $3, 'failed', $4)
      ON CONFLICT (user_id, date_string) DO UPDATE SET status = 'failed', failure_reason = $4, retry_count = retry_count + 1
    `, [record.user_id, record.date_string, record.penalty_amount, err.message])
    await pool.query(`UPDATE daily_records SET charge_status = 'failed' WHERE user_id = $1 AND date_string = $2`, [record.user_id, record.date_string])
  }
}

function getYesterdayJST() {
  const now = new Date()
  const jstOffset = 9 * 60 * 60 * 1000
  const jstNow = new Date(now.getTime() + jstOffset)
  const yesterday = new Date(jstNow.getTime() - 24 * 60 * 60 * 1000)
  return yesterday.toISOString().substring(0, 10)
}

serve({ fetch: app.fetch, port: process.env.PORT || 3000 })
console.log('FocusBet API started')
