import { audioRole, classifyFile, importFile, packFiles, removeLocal, type PackFileKey, type PackStatus } from '../../core/songpack';
import type { App } from '../app';
import { h, icon } from '../dom';

/**
 * "Song files" card: shows where each file of the current song comes from and lets the user
 * pick the ones that are missing (deployed site) or replace them. Picked files are stored in
 * this browser's IndexedDB under the song's id; nothing is uploaded anywhere.
 */
export function packFilesCard(app: App, onChange: () => void, opts: { compact?: boolean } = {}): HTMLElement {
  const body = h('div', { class: 'stack', style: 'gap:10px' });
  const msg = h('div', { class: 'notice', style: 'display:none' });
  const titleEl = h('div', { class: 'panel-title', style: 'margin:0' }, 'Song files');
  const card = h('div', { class: 'card stack pack-card' }, h('div', { class: 'row' }, icon('files', 'icon-sm'), titleEl), body, msg);

  const say = (kind: '' | 'good' | 'warn' | 'bad', text: string) => {
    msg.className = `notice ${kind}`;
    msg.textContent = text;
    msg.style.display = '';
  };

  const refresh = async () => {
    const status = await app.loadPack(true);
    if (status) render(status);
    onChange();
  };

  const pickFor = async (status: PackStatus, key: PackFileKey, file: File) => {
    try {
      await importFile(status.song, key, file);
      say('good', `${file.name} saved as ${packFiles(status.song).find((s) => s.key === key)!.label.toLowerCase()}.`);
    } catch (e) {
      say('bad', `${file.name}: ${(e as Error).message}`);
    }
    await refresh();
  };

  const handleFiles = async (status: PackStatus, files: FileList | File[]) => {
    const unknown: File[] = [];
    const unused: File[] = [];
    for (const f of [...files]) {
      const key = classifyFile(f, status.song);
      if (key) await pickFor(status, key, f);
      else if (audioRole(f.name) === 'vocal') unused.push(f);
      else unknown.push(f);
    }
    const notes: string[] = [];
    if (unused.length) notes.push(`${unused.map((f) => f.name).join(', ')} looks like the isolated vocal. The app does not play it for this song; it is only read by prepare-song.`);
    if (unknown.length) notes.push(`Could not tell what ${unknown.map((f) => f.name).join(', ')} is. Use the Choose button next to the right slot.`);
    if (notes.length) say('warn', notes.join(' '));
  };

  const render = (status: PackStatus) => {
    titleEl.textContent = `Song files · ${status.song.title}`;
    const rows = packFiles(status.song).map((spec) => {
      const key = spec.key;
      const src = status.sources[key];
      const input = h('input', {
        type: 'file',
        style: 'display:none',
        accept: spec.kind === 'audio' ? 'audio/*,.mp3,.m4a,.wav' : spec.kind === 'json' ? '.json,application/json' : '.txt,.lrc,text/plain',
        onchange: () => {
          const f = input.files?.[0];
          input.value = '';
          if (f) void pickFor(status, key, f);
        },
      });
      const state =
        src === 'static'
          ? h('span', { class: 'chip ok' }, h('i', { class: 'dot' }), 'in project folder')
          : src === 'local'
            ? h('span', { class: 'chip ok' }, h('i', { class: 'dot' }), 'saved in this browser')
            : h('span', { class: `chip ${spec.required ? 'warn' : ''}` }, h('i', { class: 'dot' }), spec.required ? 'missing (required)' : 'missing (optional)');
      return h(
        'div',
        { class: 'pack-row' },
        h('div', { class: 'grow' }, h('div', null, spec.label), opts.compact ? null : h('div', { class: 'desc' }, `${spec.name} · ${spec.hint}`)),
        state,
        h('button', { class: 'btn small', onclick: () => input.click() }, src === 'missing' ? 'Choose' : 'Replace'),
        src === 'local'
          ? h(
              'button',
              {
                class: 'btn ghost small',
                onclick: async () => {
                  await removeLocal(status.song, key);
                  await refresh();
                },
              },
              'Remove',
            )
          : null,
        input,
      );
    });
    const multi = h('input', {
      type: 'file',
      multiple: true,
      style: 'display:none',
      onchange: () => {
        if (multi.files?.length) void handleFiles(status, multi.files);
        multi.value = '';
      },
    });
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
          if (e.dataTransfer?.files.length) void handleFiles(status, e.dataTransfer.files);
        },
      },
      h('span', null, 'Drop the song files here, or '),
      h('button', { class: 'btn small', onclick: () => multi.click() }, 'choose files'),
      h('span', { class: 'faint tiny', style: 'display:block;margin-top:6px' }, status.song.referenceKind === 'vocal' ? 'Sorted by name: "karaoke" or "instrumental" → instrumental, "vocals only" or "acapella" → reference, .txt → lyrics.' : 'Sorted by name: "karaoke" or "instrumental" → instrumental, "full" or "with vocals" → reference, .txt → lyrics.'),
    );
    body.replaceChildren(...rows, drop, multi);
    if (status.errors.length) say('warn', status.errors.join(' · '));
  };

  if (app.packStatus) render(app.packStatus);
  else void app.loadPack().then((status) => status && render(status));
  return card;
}
