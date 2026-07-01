// Парсер текстур WAD3 (GoldSrc/Half-Life). Формат:
// header: "WAD3"(4) + int32 numLumps + int32 dirOfs
// directory: 32 байта на запись — filepos,disksize,size,type(1),compression(1),pad(2),name[16]
// miptex (type 0x43): name[16] + width + height + offsets[4] (в mip0 обычно есть данные),
// после mip-данных: uint16 (=256) + палитра 256×RGB.

export interface WadTex { width: number; height: number; rgba: Uint8Array; }

export function parseWad(buf: ArrayBuffer): Map<string, WadTex> {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  const out = new Map<string, WadTex>();
  if (magic !== 'WAD3' && magic !== 'WAD2') return out;
  const numLumps = dv.getInt32(4, true);
  const dirOfs = dv.getInt32(8, true);
  for (let i = 0; i < numLumps; i++) {
    const o = dirOfs + i * 32;
    const filepos = dv.getInt32(o, true);
    let name = '';
    for (let c = 0; c < 16; c++) { const ch = dv.getUint8(o + 16 + c); if (!ch) break; name += String.fromCharCode(ch); }
    // miptex_t в лампе: name[16] + width(u32) + height(u32) + offsets[4](u32)
    const mw = dv.getUint32(filepos + 16, true);
    const mh = dv.getUint32(filepos + 20, true);
    const mip0Off = dv.getUint32(filepos + 24, true);
    if (!mw || !mh || mw > 2048 || mh > 2048 || !mip0Off) continue;
    const idxStart = filepos + mip0Off;
    const npix = mw * mh;
    // после всех 4 mip-уровней (mip0..mip3, размеры w*h, (w/2)*(h/2), (w/4)*(h/4), (w/8)*(h/8)) идёт
    // 2-байтовый счётчик палитры (обычно 256) и сама палитра 256*3 (RGB)
    const mipTotal = npix + (npix >> 2) + (npix >> 4) + (npix >> 6);
    const palOff = idxStart + mipTotal + 2;
    if (palOff + 768 > bytes.length) continue;
    const rgba = new Uint8Array(npix * 4);
    for (let p = 0; p < npix; p++) {
      const pi = bytes[idxStart + p];
      const r = bytes[palOff + pi * 3], g = bytes[palOff + pi * 3 + 1], b = bytes[palOff + pi * 3 + 2];
      rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = 255;
    }
    out.set(name.toLowerCase(), { width: mw, height: mh, rgba });
  }
  return out;
}
