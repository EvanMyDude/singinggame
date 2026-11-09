import { PACK_FILES, classifyFile, importFile, removeLocal, type PackFileKey, type PackStatus } from '../../core/songpack';
import type { App } from '../app';
import { h, icon } from '../dom';

/**
 * "Song files" card: shows where each file of the song pack comes from and lets the user
 * pick the ones that are missing (deployed site) or replace them. Picked files are stored in
 * this browser's IndexedDB; nothing is uploaded anywhere.
 */
export function packFilesCard(app: App, onChange: () => void, opts: { compact?: boolean } = {}): HTMLElement {
  const body = h('div', { class: 'stack', style: 'gap:10px' });
  const msg = h('div', { class: 'notice', style: 'display:none' });
  const card = h('div', { class: 'card stack pack-card' }, h('div', { class: 'row' }, icon('files', 'icon-sm'), h('div', { class: 'panel-title', style: 'margin:0' }, 'Song files')), body, msg);

  const say = (kind: '' | 'good' | 'warn' | 'bad', text: string) => {
    msg.className = `notice ${kind}`;
    msg.textContent = text;
    msg.style.display = '';
  };

  const refresh = async () => {
    await app.loadPack(true);
    render(app.packStatus!);
    onChange();
  };

  const pickFor = async (key: PackFileKey, file: File) => {
    try {
      await importFile(key, file);
      say('good', `${file.name} saved as ${PACK_FILES[key].label.toLowerCase()}.`);
    } catch (e) {
      say('bad', `${file.name}: ${(e as Error).message}`);
    }
    await refresh();
  };

  const handleFiles = async (files: FileList | File[]) => {
    const unknown: File[] = [];
    for (const f of [...files]) {
      const key = classifyFile(f);
      if (key) await pickFor(key, f);
      else unknown.push(f);
    }
    if (unknown.length) say('warn', `Could not tell what ${unknown.map((f) => f.name).join(', ')} is. Use the Choose button next to the right slot.`);
  };

  const render = (status: PackStatus) => {
    const rows = (Object.keys(PACK_FILES) as PackFileKey[]).map((key) => {
      const spec = PACK_FILES[key];
      const src = status.sources[key];
      const input = h('input', {
        type: 'file',
        style: 'display:none',
        accept: spec.kind === 'audio' ? 'audio/*,.mp3,.m4a,.wav' : spec.kind === 'json' ? '.json,application/json' : '.txt,.lrc,text/plain',
        onchange: () => {
          const f = input.files?.[0];
          input.value = '';
          if (f) void pickFor(key, f);
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
                  await removeLocal(key);
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
        if (multi.files?.length) void handleFiles(multi.files);
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
          if (e.dataTransfer?.files.length) void handleFiles(e.dataTransfer.files);
        },
      },
      h('span', null, 'Drop the song files here, or '),
      h('button', { class: 'btn small', onclick: () => multi.click() }, 'choose files'),
      h('span', { class: 'faint tiny', style: 'display:block;margin-top:6px' }, 'Sorted by name: "karaoke" or "instrumental" → instrumental, "vocals" or "reference" → reference, .txt → lyrics.'),
    );
    body.replaceChildren(...rows, drop, multi);
    if (status.errors.length) say('warn', status.errors.join(' · '));
  };

  if (app.packStatus) render(app.packStatus);
  else void app.loadPack().then(render);
  return card;
}
