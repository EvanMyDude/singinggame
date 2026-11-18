import { deleteLocalSong, songPackage } from '../../core/localSongs';
import { forgetPack } from '../../core/songpack';
import type { SongDef } from '../../core/songs';
import type { App } from '../app';
import { downloadBlob, h } from '../dom';

/**
 * Settings card for a song added in this browser: make its targets again, download the
 * derived files to commit it to the project, or delete it.
 */
export function localSongCard(app: App, song: SongDef): HTMLElement {
  const msg = h('div', { class: 'notice', style: 'display:none' });
  const say = (kind: '' | 'good' | 'bad', text: string) => {
    msg.className = `notice ${kind}`;
    msg.textContent = text;
    msg.style.display = '';
  };

  const download = async () => {
    try {
      const pkg = await songPackage(song);
      downloadBlob(pkg.name, pkg.blob);
      say(
        'good',
        `Downloaded ${pkg.name} (${pkg.files.map((f) => f.split('/')[1]).join(', ')}). To add the song to the project: unzip it into public/songs/, add "${song.id}" to public/songs/index.json, and put the audio files next to them under the names in song.json (they stay git-ignored).`,
      );
    } catch (e) {
      say('bad', `Could not make the package: ${(e as Error).message}`);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${song.title} from this browser? Its audio, targets, lyrics, timing and scores are removed.`)) return;
    try {
      await deleteLocalSong(song.id);
      forgetPack(song.id);
      app.store.forgetSong(song.id);
      await app.reloadRegistry();
      app.go({ name: 'home' });
    } catch (e) {
      say('bad', `Could not delete the song: ${(e as Error).message}`);
    }
  };

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'panel-title' }, `Added in this browser · ${song.title}`),
    h('p', { class: 'muted small', style: 'margin-top:0' }, 'This song’s files and pitch targets are stored only in this browser. Download the package to commit the song to the project and have it on every device.'),
    h(
      'div',
      { class: 'row', style: 'flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: () => app.go({ name: 'addSong', songId: song.id }) }, 'Analyze again'),
      h('button', { class: 'btn', onclick: () => void download() }, 'Download song package'),
      h('button', { class: 'btn danger', onclick: () => void remove() }, 'Delete song'),
    ),
    msg,
  );
}
