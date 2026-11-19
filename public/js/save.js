/**
 * Save a file that arrives in pieces (decrypted download or direct transfer).
 *
 * - Chrome/Edge on desktop: asks where to save, then streams straight to disk,
 *   so even multi-GB files don't need to fit in memory.
 * - Everywhere else (phones, Firefox, Safari): collects the pieces as Blobs (the
 *   browser can keep these on disk) and triggers a normal download at the end.
 *
 * Call openSink() directly inside a click handler: the save dialog needs a user gesture.
 */
export async function openSink(name, mime) {
  if (typeof window.showSaveFilePicker === 'function' && window.isSecureContext) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      return {
        streaming: true,
        write: (data) => writable.write(data),
        close: () => writable.close(),
        abort: () => writable.abort().catch(() => {}),
      };
    } catch (err) {
      if (err.name === 'AbortError') throw err; // user closed the dialog
      // Otherwise fall back to the in-browser method below.
    }
  }

  let parts = [];
  return {
    streaming: false,
    write(data) { parts.push(new Blob([data])); },
    close() {
      const blob = new Blob(parts, { type: mime || 'application/octet-stream' });
      parts = [];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    abort() { parts = []; },
  };
}
