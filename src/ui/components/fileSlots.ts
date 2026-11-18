import { h } from '../dom';

/**
 * The pieces of a "pick your files" card, shared by the Song files card (packFiles.ts) and
 * Add song (screens/addSong.ts): one row per file slot, and a drop area that takes several
 * files at once. Each caller keeps its own logic (where a file goes, what a row's state is);
 * these only draw the controls and hand back what the user picked.
 */

/** A hidden file input; `open()` shows the browser's picker. */
function picker(accept: string | null, multiple: boolean, onFiles: (files: File[]) => void): HTMLInputElement {
  const input = h('input', {
    type: 'file',
    style: 'display:none',
    ...(accept ? { accept } : {}),
    ...(multiple ? { multiple: true } : {}),
    onchange: () => {
      const files = input.files ? [...input.files] : [];
      input.value = '';
      if (files.length) onFiles(files);
    },
  });
  return input;
}

/** The state chip of a slot with no file: required slots warn. */
export function missingChip(required: boolean): HTMLElement {
  return h('span', { class: `chip ${required ? 'warn' : ''}` }, h('i', { class: 'dot' }), required ? 'missing (required)' : 'missing (optional)');
}

export interface FileSlot {
  label: string;
  /** Second line under the label; null leaves it out. */
  desc: string | null;
  /** Where the file is, or that it is missing (missingChip). */
  state: HTMLElement;
  /** The picker's accepted types; null shows no Choose / Replace button. */
  accept: string | null;
  /** Whether the slot has a file: the button then reads Replace instead of Choose. */
  filled: boolean;
  onPick: (file: File) => void;
  /** Shows a Remove button when given. */
  onRemove?: () => void;
}

/** One file slot: label and description, its state, Choose or Replace, and Remove when allowed. */
export function fileSlotRow(s: FileSlot): HTMLElement {
  const input = s.accept !== null ? picker(s.accept, false, (files) => s.onPick(files[0]!)) : null;
  return h(
    'div',
    { class: 'pack-row' },
    h('div', { class: 'grow' }, h('div', null, s.label), s.desc !== null ? h('div', { class: 'desc' }, s.desc) : null),
    s.state,
    input ? h('button', { class: 'btn small', onclick: () => input.click() }, s.filled ? 'Replace' : 'Choose') : null,
    s.onRemove ? h('button', { class: 'btn ghost small', onclick: s.onRemove }, 'Remove') : null,
    input,
  );
}

/** A drop area for several files at once, with a "choose files" button for the same. */
export function fileDropZone(o: { hint: string; onFiles: (files: File[]) => void }): HTMLElement {
  const multi = picker(null, true, o.onFiles);
  const drop = h(
    'div',
    {
      class: 'dropzone',
      ondragover: (e: DragEvent) => {
        e.preventDefault();
        drop.classList.add('over');
      },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        drop.classList.remove('over');
        if (e.dataTransfer?.files.length) o.onFiles([...e.dataTransfer.files]);
      },
    },
    h('span', null, 'Drop the song files here, or '),
    h('button', { class: 'btn small', onclick: () => multi.click() }, 'choose files'),
    h('span', { class: 'faint tiny', style: 'display:block;margin-top:6px' }, o.hint),
    multi,
  );
  return drop;
}
