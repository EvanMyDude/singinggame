import { midiToSong, parseMidi } from '../../core/midi';
import type { Song } from '../../core/song';

export async function importMidiFile(file: File): Promise<{ song: Song; note: string } | { error: string }> {
  if (file.size > 4 * 1024 * 1024) return { error: 'That file is larger than 4 MB, which is too big for a MIDI melody.' };
  try {
    const buf = await file.arrayBuffer();
    const parsed = parseMidi(buf);
    const title = file.name.replace(/\.(mid|midi|kar)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported song';
    let hash = 0;
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 4096))) hash = (hash * 31 + bytes[i]!) | 0;
    return midiToSong(parsed, { id: `import-${(hash >>> 0).toString(36)}-${bytes.length}`, title });
  } catch (e) {
    return { error: `Could not import "${file.name}": ${(e as Error).message}.` };
  }
}
