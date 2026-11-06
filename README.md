# NOVO-BE

A single-page web app that turns raw frames from the NOVO detector backend into ROOT files. Everything runs in the browser: nothing is uploaded to a server.

**Open it:** https://asumankolbasi.github.io/novo-be/ (or clone the repository and open `index.html`).

## What it does

1. **Data** – load the `dma0.bin`, `dma1.bin` and `meta.json` files of one run from your computer (file picker or drag and drop).
2. **Time** – select the time range of interest on the count-rate plot and process it.
3. **Waveform** – browse single frames; drag the short/long gate bands and the threshold line to tune the charge integration.
4. **PSD** – look at the PSD–energy map and set the n/γ cut: by hand, from the two-Gaussian fit, or as an energy-dependent curve fitted slice by slice.
5. **Save** – build the ROOT files and download them one by one or as a ZIP, together with `settings.json` and `run.info`.

## Output

The layout is the one of CAEN CoMPASS (trees `Data_R` / `Data_F`, same branch names and types), so analysis macros written for CoMPASS read these files unchanged:

```
<run>/RAW/DataR_CH0@NOVO_<id>_<run>.root        TTree Data_R  – every frame of the selected window
<run>/RAW/DataR_CH1@NOVO_<id>_<run>.root
<run>/FILTERED/DataF_CH0@NOVO_<id>_<run>.root   TTree Data_F  – events passing the filters
<run>/FILTERED/DataF_CH1@NOVO_<id>_<run>.root
<run>/settings.json, <run>/run.info
```

| Branch | Type | Content |
|---|---|---|
| `Channel` | `UShort_t` | 0 / 1: the SiPM at either end of the scintillator bar |
| `Timestamp` | `ULong64_t` | picoseconds from the first sample of the first frame (CFD fine time included by default) |
| `Board` | `UShort_t` | detector id from the frame header |
| `Energy` | `UShort_t` | Q_long / divisor (baseline-subtracted ADC codes summed over the long gate) |
| `EnergyShort` | `UShort_t` | Q_short / divisor |
| `Flags` | `UInt_t` | 0x1 pile-up · 0x2 ADC saturation · 0x4 no valid pulse · 0x8 frames lost before · 0x10 outside coincidence window · 0x40 neutron class |
| `Samples` | `TArrayS` | optional waveform: 1012 signed 14-bit ADC codes, 769.23 ps per sample |

PSD = (Energy − EnergyShort) / Energy. The divisor (1 by default, powers of two when needed) keeps the 16-bit fields from overflowing and is recorded in `settings.json`.

## Input

Raw DMA captures of the NOVO backend: 4096-byte frames with a 32-byte header (detector id, 64-bit timestamp at 1.3 GHz, packet counter) followed by 1012 samples per channel, interleaved in blocks of four. Both DMA files of a run are merged by timestamp.

Files are streamed, never loaded whole: opening a run scans the headers (about 100 bytes of memory per frame), processing reads the selected time window in 16 MB chunks through a pool of Web Workers and keeps only the per-frame results, and single waveforms are read from disk on demand. Multi-GB runs are fine; a 5.8 GB run (1.4 million frames) opens in seconds and processes in well under a minute on a laptop.

## If loading fails with "The requested file could not be read…"

The browser could not open the file after you selected it. On macOS this almost always means the browser is not allowed to read the folder (System Settings → Privacy & Security → Files and Folders → your browser → allow Desktop / Documents / Downloads, or give it Full Disk Access), or the file is a cloud placeholder (iCloud "optimize storage", OneDrive, Google Drive) or sits on a network share. Allow the access or copy the run to a local folder outside Desktop / Documents / Downloads, then load it again.

## Files

- `index.html`, `app.js`, `style.css` – the page
- `pipeline.js` – frame decoding, pulse processing, histograms, export
- `rootwriter.js` – ROOT file writer (uncompressed TTree, verified byte-for-byte against ROOT 6.40)
- `zip.js` – ZIP packaging for the download

Plotly is loaded from a CDN; no build step is needed.
