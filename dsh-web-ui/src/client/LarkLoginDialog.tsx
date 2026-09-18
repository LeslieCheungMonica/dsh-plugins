/**
 * The dialog that completes a Feishu login in place.
 *
 * It exists because of one failure and no other: a call answered
 * `scope-missing` (or "nobody is signed in"). Every other Feishu failure in this
 * panel is answered by pressing Retry, but retrying an authorization that was
 * never granted changes nothing — the operator has to authorize, and until now
 * the only place to do that was a terminal (`lark-cli auth login`), which is not
 * where they are.
 *
 * The flow is the CLI's own device flow, in three steps:
 *
 * 1. **Start** — the host asks the CLI for a device code and renders its QR. The
 *    scopes come from the failure that opened this dialog, so the operator
 *    authorizes what the panel actually needed.
 * 2. **Authorize** — the operator scans the QR (or opens the page) and confirms
 *    in Feishu. Nothing here observes that directly, because nothing can: the
 *    device flow has no read-only "has the human scanned yet" call.
 * 3. **Finish** — a background `auth login --device-code …` child, already
 *    running since step 1, is what the CLI offers to learn the answer. When it
 *    exits successfully the login is DONE, which is why this dialog never asks
 *    the operator to press a second button: `phase: 'done'` closes it and the
 *    panel re-reads what failed.
 *
 * So the copy here says what happens on its own, and the only buttons are the two
 * that are real: open the page in a browser (for an operator who would rather not
 * scan), and give up.
 *
 * @module dsh-web-ui/client/LarkLoginDialog
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './contract.ts'
import { cancelLarkLogin, readLarkLogin, startLarkLogin } from './larkapi.ts'

/**
 * How often the dialog asks the host where the login stands.
 *
 * The host only learns the answer when its child exits, so this is the panel's
 * resolution on "the operator just scanned": short enough to feel immediate, long
 * enough that a ten-minute wait is not ten minutes of polling.
 */
const POLL_MS = 1_500

/** What the dialog is doing, which is more than the host's own four phases. */
type Stage =
  /** Asking the host to register a device code and render its QR. */
  | 'starting'
  /** The QR is up and the host is waiting for the operator. */
  | 'waiting'
  /** The device code died unread, or the CLI refused: a new QR is the only way on. */
  | 'stopped'

/** Props: whether it is open, what to ask for, and how it ends. */
export interface LarkLoginDialogProps {
  /** Whether the dialog is up. It renders nothing while closed. */
  readonly open: boolean
  /**
   * The scopes to request — the ones the failure named. Empty (or absent) asks
   * for the host's own set, which is what "nobody is signed in" needs.
   */
  readonly scopes?: readonly string[] | undefined
  /** The plugin's translator (namespace `webui`). */
  readonly t: TranslateNS<typeof NS>
  /** The login succeeded: close this and re-read what failed. */
  readonly onDone: () => void
  /** The operator dismissed it (or it finished). */
  readonly onClose: () => void
}

/**
 * Render the login dialog.
 * @param props - see {@link LarkLoginDialogProps}.
 * @returns the dialog element.
 */
export function LarkLoginDialog({ open, scopes, t, onDone, onClose }: LarkLoginDialogProps): ReactNode {
  const [stage, setStage] = useState<Stage>('starting')
  const [qrUrl, setQrUrl] = useState('')
  const [verificationUrl, setVerificationUrl] = useState('')
  const [requested, setRequested] = useState<readonly string[]>(scopes ?? [])
  const [secondsLeft, setSecondsLeft] = useState(0)
  /** The host's own words when something failed. */
  const [failure, setFailure] = useState('')
  /**
   * Which attempt this render belongs to. Every reply compares against it, so a
   * QR from a superseded attempt can never be shown as the current one — the
   * same guard the panel puts around its folder reads.
   */
  const attempt = useRef(0)
  /**
   * The parent's callbacks, read through refs.
   *
   * The panel passes them as inline arrows, so their identity changes on every
   * render — and the poll effect depends on the callback it calls. Depending on
   * the callbacks themselves would tear the interval down and restart it on any
   * unrelated re-render; a ref keeps the timer running and still calls the
   * current one.
   */
  const latest = useRef({ onDone, onClose })
  latest.current = { onDone, onClose }

  /**
   * Ask the host for a device code and its QR.
   *
   * Called on open and again for "generate a new QR": a dead device code can only
   * be replaced, never resumed.
   */
  const begin = useCallback(async (): Promise<void> => {
    attempt.current += 1
    const mine = attempt.current
    setStage('starting')
    setFailure('')
    setQrUrl('')
    setVerificationUrl('')
    const started = await startLarkLogin(scopes)
    if (mine !== attempt.current) return
    if (!started.ok) {
      setStage('stopped')
      setFailure(started.error.message)
      return
    }
    setQrUrl(started.value.qrUrl)
    setVerificationUrl(started.value.verificationUrl)
    setRequested(started.value.scopes)
    setSecondsLeft(started.value.expiresIn)
    setStage('waiting')
  }, [scopes])

  // One start per open, and one per change of scope: reopening for a different
  // failure must not keep showing the previous one's QR.
  useEffect(() => {
    if (!open) return
    void begin()
  }, [begin, open])

  /**
   * Poll while the QR is up. The interval dies with the effect, so a closed
   * dialog stops asking — the host keeps waiting either way, because its child is
   * what holds the device code.
   */
  useEffect(() => {
    if (!open || stage !== 'waiting') return undefined
    const mine = attempt.current
    const timer = setInterval(() => {
      void (async () => {
        const answer = await readLarkLogin()
        if (mine !== attempt.current) return
        if (!answer.ok) {
          // A poll that cannot reach the host is not a failed login: the CLI is
          // still waiting, so the dialog keeps waiting with it.
          return
        }
        const login = answer.value
        setSecondsLeft(login.expiresIn)
        if (login.phase === 'done') {
          // The login landed. The parent closes this dialog and re-reads what
          // failed, so there is no "success" state to render here.
          latest.current.onDone()
          return
        }
        if (login.phase === 'failed') {
          setStage('stopped')
          setFailure(login.message)
          return
        }
        if (login.expired) {
          setStage('stopped')
          setFailure(t('lark.login.expired'))
        }
      })()
    }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [open, stage, t])

  /**
   * Leave the flow.
   *
   * Cancelling kills the host's child. That is not tidiness: the child holds a
   * device code that stays live for its full ten minutes, and the CLI's codes are
   * one-shot, so an abandoned one would collide with the next login.
   */
  const dismiss = useCallback((): void => {
    attempt.current += 1
    void cancelLarkLogin()
    latest.current.onClose()
  }, [])

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title={t('lark.login.title')}
      closeLabel={t('lark.login.close')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={dismiss}>{t('lark.login.cancel')}</Button>
          {(stage === 'stopped') && (
            <Button variant="primary" size="sm" onClick={() => { void begin() }}>
              {t('lark.login.regenerate')}
            </Button>
          )}
        </>
      )}
    >
      <div data-wui="larkLogin" data-stage={stage}>
        {stage === 'starting' && <p data-wui="larkLoginNote">{t('lark.login.starting')}</p>}

        {stage === 'stopped' && (
          <p data-wui="larkLoginNote" data-tone="error">
            <span data-wui="larkLoginFailure">{failure}</span>
            {' '}
            {t('lark.login.retryHint')}
          </p>
        )}

        {stage === 'waiting' && (
          <>
            <p data-wui="larkLoginNote">{t('lark.login.scan')}</p>
            {qrUrl !== '' && (
              <img
                data-wui="larkLoginQr"
                src={qrUrl}
                alt={t('lark.login.qrAlt')}
                width={240}
                height={240}
              />
            )}
            {verificationUrl !== '' && (
              <p data-wui="larkLoginLink">
                <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                  {t('lark.login.open')}
                </a>
              </p>
            )}
            {requested.length > 0 && (
              <p data-wui="larkLoginScopes">{t('lark.login.scopes', { scopes: requested.join(' ') })}</p>
            )}
            {secondsLeft > 0 && (
              <p data-wui="larkLoginCountdown">{t('lark.login.expiresIn', { n: secondsLeft })}</p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
