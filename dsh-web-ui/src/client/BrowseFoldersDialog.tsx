/**
 * In-app folder browser: the stand-in for the host's native directory chooser.
 *
 * The host composes exactly ONE directory capability at boot
 * (`dsh-host-directory-picker-auto`): `native` on a local desktop session,
 * `browse` when the session is remote (SSH/LAN). `pickDirectory()` answers
 * `directory-picker-unavailable` on a browse-only host, so the New Project flow
 * opens this dialog over the very same capability's listing verbs
 * (`listDirectory` / `createDirectory`) and hands the chosen absolute path back
 * to the same adoption path.
 *
 * The directory is the project: this dialog only selects one, and it can create
 * a folder to select, which is the only "new folder" route a project needs.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconChevronLeftOutline14, IconFolderClose16, IconFolderOpen16, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './contract.ts'

/** The translator seat this plugin's copy arrives through. */
type T = TranslateNS<typeof NS>

/** Last path segment of a host path, for a compact crumb. */
function baseName(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0)
  return parts[parts.length - 1] ?? path
}

/**
 * The parent of an absolute host path, derived from the path itself rather than
 * from the listing's breadcrumb ancestry (which is host-shaped and may stop at
 * the host's search root).
 * @param path - absolute directory path.
 * @returns the parent path, or undefined at the filesystem root.
 */
function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  if (cut > 0) return trimmed.slice(0, cut)
  return cut === 0 ? '/' : undefined
}

/**
 * Render the folder browser.
 * @param props - listing verbs, the pick callback, and copy.
 * @returns the dialog element (null while closed).
 */
export function BrowseFoldersDialog({ open, listDirectory, createDirectory, onPicked, onClose, t }: {
  open: boolean
  listDirectory: (path?: string) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  onPicked: (path: string) => void
  onClose: () => void
  t: T
}): ReactNode {
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [naming, setNaming] = useState(false)

  /** Read one level; `undefined` asks the host for its home directory. */
  const load = useCallback((path?: string): void => {
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        setListing(await listDirectory(path))
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setLoading(false)
      }
    })()
  }, [listDirectory])

  // A project picker always opens somewhere real: the host home when the
  // caller has no path to offer.
  useEffect(() => {
    if (!open) {
      setListing(null)
      setError(null)
      setNaming(false)
      setFolderName('')
      return
    }
    load()
  }, [load, open])

  const parent = listing === null ? undefined : parentOf(listing.path)

  const create = (): void => {
    const name = folderName.trim()
    if (listing === null || name.length === 0) return
    void (async () => {
      try {
        const created = await createDirectory(listing.path, name)
        setNaming(false)
        setFolderName('')
        load(created)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('picker.title')}
      description={t('picker.description')}
      closeLabel={t('picker.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('picker.cancel')}</Button>
          <Button
            variant="primary"
            size="sm"
            disabled={listing === null || loading}
            onClick={() => { if (listing !== null) onPicked(listing.path) }}
          >
            {t('picker.select')}
          </Button>
        </>
      )}
    >
      <div data-wui="browseCrumbs">
        <button
          type="button"
          data-wui="iconButton"
          aria-label={t('picker.up')}
          title={t('picker.up')}
          disabled={parent === undefined || loading}
          onClick={() => { if (parent !== undefined) load(parent) }}
        >
          <IconChevronLeftOutline14 size={14} />
        </button>
        <span data-wui="browsePath" title={listing?.path ?? ''}>
          {listing === null ? t('picker.loading') : baseName(listing.path)}
        </span>
      </div>

      <div data-wui="browseList">
        {error !== null && <div data-wui="browseEmpty">{error}</div>}
        {error === null && listing !== null && listing.entries.length === 0 && !loading && (
          <div data-wui="browseEmpty">{t('picker.empty')}</div>
        )}
        {error === null && listing?.entries.map(entry => (
          <button
            key={entry.path}
            type="button"
            data-wui="browseRow"
            onClick={() => { load(entry.path) }}
          >
            <IconFolderClose16 size={16} />
            {entry.name}
          </button>
        ))}
      </div>

      <div data-wui="newFolderRow">
        {naming
          ? (
            <>
              <Input
                // The inline form is opened by an explicit click on a
                // one-field form, so the field owns the focus immediately.
                autoFocus
                value={folderName}
                placeholder={t('picker.newFolder.placeholder')}
                onChange={(event) => { setFolderName(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') create()
                  if (event.key === 'Escape') setNaming(false)
                }}
              />
              <Button variant="primary" size="sm" onClick={create}>{t('picker.create')}</Button>
            </>
          )
          : (
            <Button
              variant="ghost"
              size="sm"
              icon={<IconFolderOpen16 size={16} />}
              disabled={listing === null || loading}
              onClick={() => { setNaming(true) }}
            >
              {t('picker.newFolder')}
            </Button>
          )}
      </div>
    </Modal>
  )
}
