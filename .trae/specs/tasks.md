# Caso 3 - Control de Frecuencia - Implementation Plan

Stack elegido: **Vite + TypeScript vanilla (sin framework UI)** sobre **Canvas 2D** sin teselas externas; 4 Web Workers para geometría; 1 Shared Worker opcional si se abre centro + supervisor en dos pestañas; Service Worker para offline. La elección se detalla en el README.

---

## Task 1: Scaffold del proyecto (Vite + TS + COOP/COEP headers)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Inicializar Vite + TS vanilla en repo.
  - Configurar `vite.config` headers `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp` (tanto dev server como preview).
  - Añadir `package.json` scripts: `dev`, `build`, `preview`, `sim:stats`.
  - Carpetas: `src/worker`, `src/render`, `src/core`, `src/sim`, `src/sw`, `src/ui`, `public/`, `data/`.
- **Acceptance Criteria Addressed**: RT-5 (base), RT-10 (base build)
- **Test Requirements**:
  - `rule` TR-1.1: `npm run build` termina sin errores; abrir `npm run dev` → consola `crossOriginIsolated === true`.
  - `rule` TR-1.2: Vite config define `crossOriginOpenerPolicy` y `crossOriginEmbedderPolicy` en modo dev y preview.
- **Notes**: Bloquea cualquier tarea que use SharedArrayBuffer.

## Task 2: Generador de cartografía sintética (22 rutas, par de calles paralelas + paraderos)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Generar `data/routes.json` con 22 polilíneas (900–2400 vértices, ~40k total).
  - Incluir un par de calles paralelas en el “centro” separadas 25 m, por las que pasan 9 rutas.
  - Generar `data/stops.json` con `id, route, order, meters_from_start, capacity (1..3)`.
  - Generar `data/schedule.json` con frecuencia base (ej: 6 min peak, 12 min valle) por ruta y franja.
  - Incluir función `loadRoutes()` y `loadStops()` + TS tipos `Route`, `Segment`, `Stop`.
- **Acceptance Criteria Addressed**: RF-1 (input data), RF-2 (parallel streets), RF-6 (stop capacity)
- **Test Requirements**:
  - `rule` TR-2.1: 22 rutas cargadas; vértices totales entre 35k–45k; 2 calles paralelas con Δ ≤ 30 m verificadas por distancia punto-punto; 9 rutas intersectan ambas calles.
  - `rule` TR-2.2: Cada paradero tiene `capacity ∈ [1,3]` y `meters_from_start` monótono creciente por ruta.
- **Notes**: Este dataset se usa como referencia; el validador de RF-2 depende de la geometría del par paralelo.

## Task 3: Núcleo geométrico — distancia punto-segmento + proyección sobre polilínea + índice espacial (rejilla uniforme)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - Implementar `projectPointToPolyline(pt, route)` → `{segmentIdx, t, metersFromStart, distance}` con distancia punto-segmento en lat/lon usando proyección equirectangular local.
  - Construir `SpatialGrid` (rejilla uniforme) sobre segmentos: celda `~100 m` en el centro; justificar tamaño vs densidad.
  - API: `query(pt, radiusMeters) -> SegmentCandidate[]`.
  - Benchmark interno: 10k consultas aleatorias, medir P95 y memoria.
- **Acceptance Criteria Addressed**: RF-1 (índice espacial), AC-1
- **Test Requirements**:
  - `rule` TR-3.1: `query` recupera TODOS los segmentos a ≤ radio (verificar con barruto de fuerza bruta en 100 pts aleatorios: 0 falsos negativos).
  - `rule` TR-3.2: Benchmark 10k consultas, P95 ≤ 0,1 ms y heap del índice ≤ 5 MB, visible en panel de métricas.
  - `rubric` TR-3.3: Justificación de tamaño de celda; escala 1–5; 1 = sin justificar, 3 = justificación débil, 5 = análisis densidad centro vs periferia + elección óptima; threshold ≥ 4; evidence = comentario en `SpatialGrid.ts`.

## Task 4: Pipeline RF-2 + RF-3 — HMM/Viterbi para asignación estable y posición monótona
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3
- **Description**:
  - `SequenceAssigner`: modelo de estados = segmentos candidatos en ventana; emisión = `exp(-dist/σ)`; transición = `exp(-|Δmeters_esperado − Δmeters_real| / τ)`.
  - Viterbi sobre ventana móvil de N=5 puntos; aplicar “label smoothing” o preferencia por estado anterior para estabilidad en calles paralelas.
  - `MonotonicTracker`: entrada `{busId, metersFromStart, ts}`; ignora mensajes fuera de orden (si `ts < last_ts - ε` y `meters < last_meters - tol` → drop o reubica en buffer pequeño); marca posiciones extrapoladas tras silencio como `estimated: true`.
- **Acceptance Criteria Addressed**: RF-2, RF-3, AC-2, AC-3
- **Test Requirements**:
  - `rule` TR-4.1: Sobre trayecto sintético con ruido en calles paralelas, cambios de calle falsos < 3 (ver `Task 12` / validador).
  - `rule` TR-4.2: 10 min de simulación, 0 retrocesos espurios > 5 m.
  - `rule` TR-4.3: Inyectar 3 % OOO; tracker drop o reubica sin retrocesos; huecos > 40 s marcan `estimated=true`.
- **Notes**: Este pipeline corre en Web Workers (Task 7). No ponerlo en main.

## Task 5: RF-4 Percentiles en flujo (mediana + P85) por tramo × franja
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2
- **Description**:
  - Por cada `(segmentId, timeBucket)` mantener 2 trackers del algoritmo P² para percentiles dinámicos: 1 mediana, 1 P85.
  - Observaciones fluyen desde `SequenceAssigner` al detectar paso por tramo.
  - Persistencia opcional en IndexedDB para sobrevivir a refresh; no requerida para el caso pero sí para P2.
  - Validación “batch”: guardar 1h de observaciones y comparar percentiles online vs numpy-style batch.
- **Acceptance Criteria Addressed**: RF-4, AC-4
- **Test Requirements**:
  - `rule` TR-5.1: Error relativo percentiles online vs batch < 5 % en ambos, sobre 1h de data sintética.
  - `rule` TR-5.2: Memoria por tracker ≤ 15 marcadores P²; total para ~800 tramos × 6 franjas ≤ 1 MB.

## Task 6: RF-5 Orden dinámico por posición + RF-5/RF-6 Bunching projection + retention recommender
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4, Task 5
- **Description**:
  - `DynamicOrder`: árbol ordenado o skip list por `meters` por ruta con costo O(log n) actualización; produce `orderedBusIds[]` e `intervalos[i] = pos[i]−pos[i+1]` convertidos a tiempo con velocidad/P85 del tramo.
  - `BunchingDetector`: proyecta cada intervalo T+predicción basada en `v_inst` y `P85_tramo`; alerta cuando `projected_interval < 0.4 * scheduled` y `t_horizon >= 120 s`.
  - `RetentionRecommender`: recibe alertas + capacidad de paradero próximo; propone `{busId, stopId, minutes}`. Resuelve conflictos: sort por urgencia, greedy asignando sin superar `stop.capacity` y sin generar hueco `> 1.6 * scheduled`.
- **Acceptance Criteria Addressed**: RF-5, RF-6, AC-5, AC-6
- **Test Requirements**:
  - `rule` TR-6.1: Escenario bunching reproducible → alerta emitida ≥ 120 s antes del bunching real (medido en auditor del simulador).
  - `rule` TR-6.2: Escenario de paradero compartido con cupo 3 y 5 rutas concurrentes → 0 infracciones de capacidad y 0 huecos > 160 % resultantes.
  - `rubric` TR-6.3: Criterio explícito de desempate de conflictos y justificación vs óptimo; escala 1–5; threshold ≥ 4; evidence = README sección “Stop conflict heuristic”.

## Task 7: Web Workers + distribución de rutas + mensajes de control (RT-1/3/4)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4, Task 6
- **Description**:
  - 4 instancias de `GeoWorker`; cada una asigna ~5–6 rutas (partition por hash routeId).
  - Cada Worker recibe: índice espacial (transferencia inicial de buffer si se serializa), batch de posiciones GPS por `postMessage` con `Transferable`.
  - Main NO envía flota completa por frame: solo batches de posiciones nuevas, y solo lectura desde SAB.
  - Prohibido `Atomics.wait` en main; reader usa “version check”: lee `versionStart`, lee payload, lee `versionEnd`; si `versionStart !== versionEnd || versionStart % 2 === 1` → reintento corto (hasta N=3, luego saltea frame).
- **Acceptance Criteria Addressed**: RT-1, RT-3, RT-4, AC-9
- **Test Requirements**:
  - `rule` TR-7.1: `grep -R "Atomics.wait" src --include="*.ts"` retorna 0 hits en archivos del hilo principal (`src/main.ts`, `src/render/*`, `src/ui/*`).
  - `rule` TR-7.2: 30 min de simulación con detector de tears en SAB (log en worker): 0 lecturas inconsistentes por version mismatch.
  - `rule` TR-7.3: Hilo principal no llama a `projectPointToPolyline` ni a `SequenceAssigner` en su propio código (medido por import y coverage de funciones).
- **Notes**: Bloquea Task 8 (SAB layout + shared state)

## Task 8: SharedArrayBuffer layout, doble búfer / versionado y updates desde Workers (RT-2/3/4)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 7
- **Description**:
  - Diseñar layout SAB: `[versionStart (u32), versionEnd (u32), busCount (u32), reserved, busRecords[310]]`
  - `busRecord`: `routeId (u16), status (u8), estimated (u8), meters (f32), lat (f64), lon (f64), speed (f32), heading (u16), serverTs (f64)` → ~32 bytes * 310 ≈ 10 KB.
  - Buffer circular de 2 h para replay: por bus, anillos de ~480 puntos (2h * 1 punto / 15 s) → 2 h * 310 * ~16 B ≈ 10 MB.
  - Workers escriben en “back buffer” / con incremento de versión par/impar; main lee solo cuando versionStart == versionEnd y par.
- **Acceptance Criteria Addressed**: RT-2, RT-3, RT-4, AC-9
- **Test Requirements**:
  - `rule` TR-8.1: Layout calculado correcto: `new Float64Array(SAB).length` coincide con calculo teórico.
  - `rule` TR-8.2: En modo auditor, 30 min sin lectura “a medio escribir” (version mismatch).
  - `rubric` TR-8.3: Explicación en README del esquema version/double buffer; escala 1–5; 1 = sin explicar, 3 = explica pero sin mecanismo de invalidación lector, 5 = explica par/impar + reintento lector + por qué no necesita lock; threshold ≥ 4.

## Task 9: Simulador de flota — 310 buses + todos los ruidos + bunching reproducible
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - `FleetSimulator(seed)`: recorre polilíneas con perfil de velocidad base + aceleraciones.
  - Modelos de ruido:
    - `gps_noise`: σ 8–15 m normal; centro histórico: rebotes aleatorios de hasta 60 m a calles paralelas con probabilidad proporcional a `hdop`.
    - `silence`: cada bus con probabilidad p ~ Poisson(λ), entra en “túnel” 40 s–240 s.
    - `ooo`: 3 % mensajes retardados, emitidos después de mensajes más nuevos.
    - `clock_skew`: cada bus tiene `skew ∈ U(-90 s, +90 s)`, constante por run.
    - `idle_time`: ~12 % del tiempo, bus fuera de servicio.
  - Forzar bunching: `forceBunching(routeId, busIdx, delaySeconds)`, determinista por seed.
  - Exportar stream JSON igual que WS real: `{bus, ruta, lat, lon, vel, rumbo, ts, hdop, sats}`.
- **Acceptance Criteria Addressed**: RF-9, AC-10
- **Test Requirements**:
  - `rule` TR-9.1: Estadísticas 5 min: 310 buses; error 8–15 m fuera centro; ≤ 60 m centro; silencios 40–240 s en ~5 % de buses; desfase ±90 s; ~3 % OOO; todo dentro de rangos en `stats.json`.
  - `rule` TR-9.2: Mismo seed dos runs → checksum SHA256 del stream (orden + payloads) idéntico.
  - `rule` TR-9.3: `forceBunching("R07", 3, 180)` produce intervalo < 40 % en instante esperado (±10 s).

## Task 10: Render de mapa en Canvas 2D — 60 fps, culling, estelas, 310 buses (RF-7, RT-7)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 8
- **Description**:
  - `MapRenderer(canvas, sharedState)`: pura geometría sobre canvas (sin teselas).
  - Dibujar: 22 polilíneas, paraderos como marcas, 310 buses como iconos, estela de 3 minutos polyline suave.
  - Viewport pan/zoom con matriz de transformación; **frustum culling** de segmentos y buses fuera de vista.
  - `requestAnimationFrame` único en main. Prohibido `setInterval` para dibujo.
  - Implementar slider de tiempo: leer buffer circular 2h; al arrastrar, muestrear el estado histórico en SAB temporal, sin bloquear.
- **Acceptance Criteria Addressed**: RF-7, RT-7
- **Test Requirements**:
  - `rule` TR-10.1: 0 elementos DOM por bus (chequear `document.querySelectorAll('.bus-marker').length === 0`).
  - `rule` TR-10.2: 0 llamadas a `setInterval` con callback de dibujo (`grep` exclusiones por `sim` clock).
  - `rule` TR-10.3: Con throttling CPU 4x y slider arrastrado 30 s, PerformanceObserver reporta P95(IPI) ≤ 200 ms.
  - `rubric` TR-10.4: Calidad del descarte y estelas; escala 1–5; threshold ≥ 4; evidence = flame graph sin long tasks > 50 ms.

## Task 11: UI shell — centro de control + supervisor de vía + panel de métricas (RF-7, RF-8)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 10
- **Description**:
  - Layout centro de control: mapa full + panel lateral con rutas, alertas de bunching, recomendaciones de retención (lista con ACK).
  - Vista supervisor de vía: lista de paraderos cercanos, botones `RETENER N MIN`, `BUS EN VACÍO`, `INCIDENTE`.
  - Panel interno Performance: IPI live con desglose entrada/proc/presentación, long tasks, FPS; todo via `PerformanceObserver` (RT-8).
  - Modo “validador trayecto etiquetado”: pantalla dedicada que carga trayecto, muestra ground-truth vs asignación y cuenta aciertos / cambios falsos.
- **Acceptance Criteria Addressed**: RF-7, RF-8 (UI side), RT-8, AC-7
- **Test Requirements**:
  - `rule` TR-11.1: Panel de Performance muestra IPI desglosado y marca long tasks; se registran 0 frames con IPI > 500 ms en uso normal.
  - `rule` TR-11.2: Vista supervisor contiene 3 botones de acción que encolan en `ActionQueue`.

## Task 12: Trayecto etiquetado + validador (conteo de aciertos)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2, Task 4
- **Description**:
  - Generar `data/labeled_trajectory.json`: 1 recorrido sintético sobre las calles paralelas del centro, con puntos espaciados 5 m, ruido GPS simulado y etiqueta de calle verdadera por punto.
  - `TrajectoryValidator`: corre trayecto por `SequenceAssigner`, emite `{matches, falseSwitches, accuracy}`.
  - Mostrar resultado en pantalla dedicada del UI (Task 11).
- **Acceptance Criteria Addressed**: RF-2, RF-10, AC-2, AC-12
- **Test Requirements**:
  - `rule` TR-12.1: El trayecto contiene al menos 200 puntos etiquetados.
  - `rule` TR-12.2: Validador reporta `falseSwitches < 3`; baseline de nearest-neighbor reporta `falseSwitches ≥ 15` (check de cordura).
  - `rubric` TR-12.3: Explicación en README del término de HMM/transición que logra la estabilidad; escala 1–5; threshold ≥ 4.

## Task 13: Service Worker — caché, último estado, cola de acciones (RT-6, RF-8)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 11
- **Description**:
  - `sw.ts` register; app shell cache-first; cartografía / rutas JSON cache.
  - Al escribir en SAB, snapshot periódico a IndexedDB (“último estado conocido + ts”).
  - `ActionQueue` en IndexedDB: enqueue al click offline; reintentar con backoff al recuperar red; BackgroundSync si está disponible.
  - Sincronizar al recuperar red: POST batch a endpoint (simulado por MessageChannel al simulador); confirmación visual.
- **Acceptance Criteria Addressed**: RF-8, RT-6, AC-8
- **Test Requirements**:
  - `rule` TR-13.1: DevTools → offline → refresh → app abre y muestra último estado con su timestamp.
  - `rule` TR-13.2: 3 acciones offline → recuperar red → 3 acciones confirmadas sin reintento manual; log SW muestra envío.
  - `rule` TR-13.3: Headers COOP/COEP preservados en responses cacheados.

## Task 14: Integración end-to-end + despliegue nube URL pública
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 13
- **Description**:
  - Conectar simulador al pipeline de Workers al render: `Sim → (batches 10 Hz via MessageChannel) → GeoWorkers → SAB → Render`.
  - Pantalla de “home” con selector modo: `Control Center` o `Road Supervisor`, checkbox `Enable Simulator`, seed input, botón `Force Bunching`.
  - Despliegue a Vercel (o Netlify) con verificación `crossOriginIsolated === true` y CPU 4x throttling OK.
  - Generar URL pública y anotarla.
- **Acceptance Criteria Addressed**: RT-10, AC-11
- **Test Requirements**:
  - `rule` TR-14.1: Abrir URL pública sin credenciales → `crossOriginIsolated === true`; simulador arranca; 310 buses visibles.
  - `rule` TR-14.2: Emular móvil con throttling CPU 4x; slider 30 s → P95(IPI) ≤ 200 ms.

## Task 15: README + documentación (camino GPS a alerta + tipos de Worker + decisiones)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 14
- **Description**:
  - Sección “GPS → Alert pipeline” explicando paso a paso: llegada del frame, batch a Workers, SpatialGrid candidates, HMM Viterbi, MonotonicTracker, SAB write version, DynamicOrder intervals, BunchingDetector projection, RetentionRecommender constraints, Render read version → draw.
  - Sección “Worker types” (RT-9): por qué X en Web Worker, Y en Shared Worker (si aplica), Z en Service Worker; demostrar que no son intercambiables.
  - Sección “Algorithm choices”: tamaño de rejilla RF-1, modelo HMM RF-2, percentiles P² RF-4, orden dinámico RF-5, heuristic conflicto paraderos RF-6.
  - Instrucciones de build, dev, simulator stats, validador trayecto.
- **Acceptance Criteria Addressed**: RT-9, AC-13, AC-15
- **Test Requirements**:
  - `rubric` TR-15.1: Completitud “GPS path to alert”; escala 1–5; threshold ≥ 4; evidence = sección README.
  - `rubric` TR-15.2: Justificación tipos de Worker; escala 1–5; threshold ≥ 4; evidence = sección README “Worker types”.
  - `rule` TR-15.3: `npm run dev` y `npm run build` pasan siguiendo README; instrucciones claras de validación RF-2.
