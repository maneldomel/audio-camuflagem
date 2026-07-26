import { useState, useRef, useCallback, useEffect } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import './App.css'

const CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js'
const WASM_URL  = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm'

const ffmpegInstance = new FFmpeg()

const STEPS = {
  idle:       null,
  loading:    'Carregando FFmpeg...',
  processing: 'Processando áudio...',
  done:       'Pronto!',
  error:      'Erro',
}

export default function App() {
  const [video, setVideo]         = useState(null)
  const [decoy, setDecoy]         = useState(null)
  const [decoyIsDefault, setDecoyIsDefault] = useState(false)
  const [step, setStep]           = useState('idle')
  const [progress, setProgress]   = useState(0)
  const [log, setLog]             = useState('')
  const [outputURL, setOutputURL] = useState(null)
  const [outputName, setOutputName] = useState('')
  const [draggingVideo, setDraggingVideo] = useState(false)
  const [draggingDecoy, setDraggingDecoy] = useState(false)
  const [monoVol, setMonoVol]     = useState(-31.6)
  const [testStep, setTestStep]   = useState('idle') // idle | uploading | transcribing | done | error
  const [transcript, setTranscript] = useState(null)

  const videoRef = useRef()
  const decoyRef = useRef()

  useEffect(() => {
    fetch('/decoy.mp3')
      .then(r => r.blob())
      .then(blob => {
        const file = new File([blob], 'decoy.mp3', { type: 'audio/mpeg' })
        setDecoy(file)
        setDecoyIsDefault(true)
      })
      .catch(() => {})
  }, [])

  const handleVideo = useCallback(f => {
    if (!f) return
    setVideo(f)
    setOutputURL(null)
  }, [])

  const handleDecoy = useCallback(f => {
    if (!f) return
    setDecoy(f)
    setDecoyIsDefault(false)
    setOutputURL(null)
  }, [])

  async function process() {
    if (!video || !decoy || step === 'processing') return
    setOutputURL(null)
    setProgress(0)
    setLog('')

    try {
      if (!ffmpegInstance.loaded) {
        setStep('loading')
        ffmpegInstance.on('log', ({ message }) => setLog(message))
        ffmpegInstance.on('progress', ({ progress: p }) => setProgress(Math.round(p * 100)))
        await ffmpegInstance.load({
          coreURL: await toBlobURL(CORE_URL, 'text/javascript'),
          wasmURL: await toBlobURL(WASM_URL, 'application/wasm'),
        })
      }

      setStep('processing')
      setProgress(0)

      await ffmpegInstance.writeFile('input_video', await fetchFile(video))
      await ffmpegInstance.writeFile('input_decoy', await fetchFile(decoy))

      let duration = null
      ffmpegInstance.on('log', ({ message }) => {
        const m = message.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
        if (m) duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        setLog(message)
      })

      await ffmpegInstance.exec(['-i', 'input_video', '-f', 'null', '-']).catch(() => {})

      const dur = duration ?? 60

      await ffmpegInstance.exec([
        '-y',
        '-i', 'input_video',
        '-i', 'input_decoy',
        '-filter_complex', [
          `[0:a]pan=mono|c0=0.5*c0+0.5*c1,volume=-4.0dB[orig_mono]`,
          `[1:a]atrim=duration=${dur},asetpts=PTS-STARTPTS,volume=${monoVol.toFixed(1)}dB[mp3]`,
          `[mp3][orig_mono]amerge=inputs=2,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0-0.5*c1[a]`,
        ].join(';'),
        '-map', '0:v',
        '-map', '[a]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        'output.mp4',
      ])

      const data = await ffmpegInstance.readFile('output.mp4')
      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      const url  = URL.createObjectURL(blob)

      const base = video.name.replace(/\.[^.]+$/, '')
      setOutputName(`${base}_camuflado.mp4`)
      setOutputURL(url)
      setStep('done')
      setProgress(100)

    } catch (e) {
      setStep('error')
      setLog(String(e))
    }
  }

  async function testTranscription() {
    if (!outputURL || testStep === 'uploading' || testStep === 'transcribing') return
    setTestStep('uploading')
    setTranscript(null)

    const AAI_KEY = '962f87f99092456393935e7b6c6e51ac'

    try {
      const blob = await fetch(outputURL).then(r => r.blob())

      const { upload_url } = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { authorization: AAI_KEY },
        body: blob,
      }).then(r => r.json())

      setTestStep('transcribing')

      const { id } = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: { authorization: AAI_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
      }).then(r => r.json())

      while (true) {
        await new Promise(r => setTimeout(r, 2500))
        const data = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
          headers: { authorization: AAI_KEY },
        }).then(r => r.json())
        if (data.status === 'completed') { setTranscript(data); break }
        if (data.status === 'error') throw new Error(data.error)
      }

      setTestStep('done')
    } catch (e) {
      setTranscript({ error: e.message })
      setTestStep('error')
    }
  }

  const busy = step === 'loading' || step === 'processing'

  return (
    <div className="app">
      <div className="header">
        <h1>Audio Camuflagem</h1>
        <p>Injeta o áudio original no canal estéreo e coloca um decoy no mono</p>
      </div>

      <div className="uploads">
        {/* VIDEO */}
        <div
          className={`dropzone${draggingVideo ? ' dragging' : ''}${video ? ' has-file' : ''}`}
          onClick={() => videoRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDraggingVideo(true) }}
          onDragLeave={() => setDraggingVideo(false)}
          onDrop={e => { e.preventDefault(); setDraggingVideo(false); handleVideo(e.dataTransfer.files[0]) }}
        >
          <input ref={videoRef} type="file" accept="video/*" hidden onChange={e => handleVideo(e.target.files[0])} />
          <div className="drop-label">Vídeo</div>
          {video ? (
            <div className="file-info">
              <span className="file-icon">🎬</span>
              <span className="file-name">{video.name}</span>
              <span className="file-size">{(video.size / 1024 / 1024).toFixed(1)} MB</span>
            </div>
          ) : (
            <div className="drop-hint">
              <span className="drop-icon">📁</span>
              <span>Arraste ou clique</span>
            </div>
          )}
        </div>

        <div className="plus">+</div>

        {/* DECOY */}
        <div
          className={`dropzone${draggingDecoy ? ' dragging' : ''}${decoy ? ' has-file' : ''}${decoyIsDefault ? ' default-decoy' : ''}`}
          onClick={() => decoyRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDraggingDecoy(true) }}
          onDragLeave={() => setDraggingDecoy(false)}
          onDrop={e => { e.preventDefault(); setDraggingDecoy(false); handleDecoy(e.dataTransfer.files[0]) }}
        >
          <input ref={decoyRef} type="file" accept="audio/*,video/*" hidden onChange={e => handleDecoy(e.target.files[0])} />
          <div className="drop-label">Áudio Decoy (mono)</div>
          {decoy ? (
            <div className="file-info">
              <span className="file-icon">🎵</span>
              <span className="file-name">{decoy.name}</span>
              {decoyIsDefault
                ? <span className="file-tag">padrão · clique pra trocar</span>
                : <span className="file-size">{(decoy.size / 1024 / 1024).toFixed(1)} MB</span>
              }
            </div>
          ) : (
            <div className="drop-hint">
              <span className="drop-icon">🎵</span>
              <span>Carregando...</span>
            </div>
          )}
        </div>
      </div>

      <div className="mono-control">
        <div className="mono-header">
          <label>Volume do Mono (decoy)</label>
          <span className="mono-value">{monoVol.toFixed(1)} dB</span>
        </div>
        <div className="slider-wrap">
          <input
            type="range"
            min="-60"
            max="-10"
            step="0.5"
            value={monoVol}
            onChange={e => setMonoVol(Number(e.target.value))}
            disabled={busy}
          />
        </div>
        <div className="mono-hints">
          <span>-60 dB (inaudível)</span>
          <span>-10 dB (alto)</span>
        </div>
      </div>

      <button className="btn-process" onClick={process} disabled={!video || !decoy || busy}>
        {busy ? STEPS[step] : 'Camuflar'}
      </button>

      {busy && (
        <div className="progress-wrap">
          <div className="progress-bar" style={{ width: `${progress}%` }} />
          <span className="progress-label">{progress}%</span>
        </div>
      )}

      {log && busy && (
        <div className="log">{log}</div>
      )}

      {outputURL && (
        <div className="result">
          <div className="result-icon">✅</div>
          <div className="result-text">
            <strong>{outputName}</strong>
            <span>Pronto para download</span>
          </div>
          <a className="btn-download" href={outputURL} download={outputName}>
            Baixar
          </a>
        </div>
      )}

      {outputURL && (
        <div className="test-section">
          <div className="test-header">
            <div>
              <div className="test-title">Verificar camuflagem</div>
              <div className="test-sub">Transcreve o que o fingerprint ouve (canal mono)</div>
            </div>
            <button
              className="btn-test"
              onClick={testTranscription}
              disabled={testStep === 'uploading' || testStep === 'transcribing'}
            >
              {testStep === 'uploading'    ? 'Enviando...'
               : testStep === 'transcribing' ? 'Transcrevendo...'
               : testStep === 'done'         ? 'Testar de novo'
               : 'Testar'}
            </button>
          </div>

          {(testStep === 'uploading' || testStep === 'transcribing') && (
            <div className="test-loading">
              <div className="test-spinner" />
              <span>{testStep === 'uploading' ? 'Enviando para AssemblyAI...' : 'Transcrevendo...'}</span>
            </div>
          )}

          {testStep === 'done' && transcript && (
            <div className="test-result">
              <div className="test-meta">
                <span>Idioma: <strong>{transcript.language_code?.toUpperCase() ?? '?'}</strong></span>
                <span>Confiança: <strong>{transcript.confidence ? (transcript.confidence * 100).toFixed(0) + '%' : '?'}</strong></span>
              </div>
              <p className="test-transcript">
                {transcript.text?.trim() || <em>(nada detectado — decoy inaudível ✓)</em>}
              </p>
            </div>
          )}

          {testStep === 'error' && (
            <p className="test-error">Erro: {transcript?.error}</p>
          )}
        </div>
      )}

      {step === 'error' && (
        <div className="error-box">
          <strong>Erro ao processar</strong>
          <pre>{log}</pre>
        </div>
      )}
    </div>
  )
}