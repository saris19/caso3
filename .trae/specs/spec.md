# Caso 3 - Control de Frecuencia del Transporte Público - Product Requirements Document

## Overview
- **Summary**: Construir una aplicación web desplegada en la nube que procese en vivo 310 buses sobre 22 rutas, limpiando GPS sucio, asignando posiciones a la vía correcta, detectando bunching inminente y recomendando retenciones, con un mapa a 60 fps, reproducción histórica de 2 horas y operación sin conexión para supervisores de vía.
- **Purpose**: Convertir un flujo de GPS ruidoso y desordenado en posiciones confiables por ruta, calcular intervalos entre buses y actuar antes de que se materialice el bunching.
- **Target Users**:
  - Supervisores en el centro de control (pantalla grande, escritorio, alta carga visual).
  - Supervisores de vía en paraderos (teléfonos de gama baja, conectividad irregular, CPU limitada).

## Goals
1. Reducir cambios de calle falsos en el par de calles paralelas del centro a menos de 3 en el trayecto etiquetado.
2. Detectar bunching con antelación suficiente para retener un bus antes de que la pareja se forme.
3. Sostener 310 buses renderizados a 60 fps con IPI ≤ 200 ms bajo deslizamiento del control de tiempo, incluso con CPU throttling 4x en móvil.
4. Operar sin conexión: último estado visible, acciones en cola y reenvío automático al recuperar red.

## Non-Goals
1. No hay pasajeros individuales, billetería ni planificación de nuevas rutas.
2. No se integran sistemas externos de pago ni reportes gerenciales.
3. El GPS simulado viene del simulador del repositorio; no se consume una API real de flota durante la evaluación.
4. No se resuelve el modelo de tráfico en detalle: los tiempos típicos por tramo se aprenden de observaciones en flujo.

## Background & Context
310 buses operan sobre 22 rutas que comparten tramos en el centro histórico. El GPS reporta cada 10–30 s con error de 8–15 m en vía abierta, hasta 60 m en el centro por rebote, silencios de 40 s a 4 min en túneles, desfase de reloj de hasta 90 s y 3 % de mensajes fuera de orden. Cerca del 12 % del tiempo los buses están fuera de servicio. Dos calles paralelas distan 25 m y ~9 rutas comparten la misma calle en el centro. El bunching se define como intervalo < 40 % del programado; hueco > 160 %. La acción efectiva es retener un bus en un paradero antes de que la pareja se forme.

## Functional Requirements

### RF-1 Búsqueda de candidatos sobre la cartografía
- Construir un índice espacial sobre los segmentos de las 22 rutas (~40.000 vértices) para recuperar candidatos dentro de un radio dado con costo acotado por consulta.
- Justificar tamaño de celda o criterio de partición frente a densidad desigual centro vs periferia.

### RF-2 Asignación de la posición a la vía correcta
- Combinar distancia del punto al segmento con coherencia del avance sobre la ruta (secuencia), usando una ventana móvil de pocos puntos.
- En el par de calles paralelas del centro, reducir los cambios de calle falsos a menos de 3 sobre el trayecto etiquetado (vs 15–30 del vecino más cercano).

### RF-3 Posición sobre la ruta, monótona y con huecos
- Cada bus expone una posición en metros desde el inicio de la ruta, no retrocede salvo que el bus retroceda físicamente.
- Ignorar o reubicar mensajes fuera de orden; tras silencio prolongado, estimar posición y marcarla como estimada.

### RF-4 Tiempos de recorrido por tramo
- Mantener, por tramo y franja horaria, la mediana y el percentil 85 de los últimos recorridos observados, actualizados en flujo continuo sin guardar todo el histórico.

### RF-5 Intervalos entre buses y detección temprana
- Ordenar buses por posición sobre cada ruta con actualizaciones constantes.
- Proyectar intervalos y emitir alerta de bunching inminente con la antelación suficiente para que la retención sirva.

### RF-6 Recomendación de retención
- Proponer retener un bus N minutos en un paradero, evitando generar huecos > 160 % y respetando el cupo físico del paradero (1–3 buses).
- Resolver conflictos cuando varias rutas comparten el mismo paradero con un criterio explícito.

### RF-7 Mapa a 60 fps y reproducción histórica
- Renderizar 310 buses, estela de 3 minutos, 22 rutas y paraderos sobre canvas en `requestAnimationFrame`.
- Control deslizante para retroceder hasta 2 horas y reproducir lo ocurrido; mientras se arrastra, IPI ≤ 200 ms tanto en escritorio como en móvil con CPU limitada.

### RF-8 Operación sin conexión para supervisor de vía
- Abrir sin red, mostrar el último estado conocido y su marca de hora.
- Registrar acciones (retención aplicada, bus en vacío, incidente) en cola local y reenviar automáticamente al recuperar red.

### RF-9 Simulador de flota
- Incluido en el repositorio, genera 310 buses con ruido, rebote en centro, silencios, desorden y desfase de reloj según la tabla de realidades del dato.
- Permite forzar escenarios de bunching reproducibles (seed determinista).

### RF-10 Trayecto de prueba etiquetado
- Un recorrido etiquetado a mano sobre las calles paralelas del centro, con el conteo de aciertos de la asignación (línea base vs solución).

## Non-Functional Requirements

### RT-1 Workers para geometría
- La asignación a la vía y el cálculo de posición sobre la ruta corren en Web Workers, con las rutas repartidas entre ellos.
- El hilo principal **no ejecuta geometría**.

### RT-2 SharedArrayBuffer con búfer versionado
- El estado vivo de los 310 buses vive en un `SharedArrayBuffer` con doble búfer o versionado.
- El hilo que dibuja nunca espera al que calcula y nunca lee un estado a medio escribir.

### RT-3 Sincronización con Atomics
- La sincronización usa `Atomics`.
- `Atomics.wait` **no aparece** en el hilo principal.
- Explicar cómo detecta el lector que su lectura quedó invalidada.

### RT-4 postMessage con transferibles
- `postMessage` se usa solo para control y lotes con objetos transferibles.
- Queda **prohibido** enviar el estado completo de la flota en cada cuadro.
- Reportar la medición que respalda la decisión.

### RT-5 crossOriginIsolated
- La aplicación corre con `crossOriginIsolated === true`.
- Si se usan teselas de mapa de proveedor externo, resolver el conflicto con COEP y documentar la solución.

### RT-6 Service Worker para offline
- Implementa caché del app shell, caché de teselas y cartografía, último estado conocido y cola de acciones del supervisor que se sincroniza al recuperar la red.

### RT-7 Canvas en requestAnimationFrame
- El mapa se dibuja en canvas dentro de `requestAnimationFrame`.
- Se descarta lo que queda fuera de la vista.
- Queda prohibido crear un elemento del DOM por bus y dibujar con `setInterval`.

### RT-8 Instrumentación con PerformanceObserver
- Instrumentar IPI con desglose en retardo de entrada, procesamiento y presentación, más long tasks.
- Visible dentro de la aplicación (panel interno).

### RT-9 Desglose de tipos de Worker
- Explicar para la propia aplicación qué trabajo va a Web Worker, cuál a Shared Worker y cuál a Service Worker, y por qué no son intercambiables. (Documentado en README).

### RT-10 Despliegue en nube
- Despliegue con URL pública, verificable sin intervención del autor, incluyendo prueba en teléfono real/emulado con limitación de CPU 4x.

## Constraints
- **Technical**: Navegadores modernos con SharedArrayBuffer requieren `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`. Los teléfonos de gama baja tienen CPU lenta y memoria poca.
- **Business**: El caso se evalúa en una sustentación; el simulador, el despliegue y la demo del panel de Performance son parte de la verificación.
- **Dependencies**: No se requieren proveedores externos de teselas para aprobar (se puede dibujar la red a partir de las polilíneas). Si se usan, COEP/COOP debe estar resuelto.

## Assumptions
1. La cartografía de 22 rutas se entrega como JSON de polilíneas; si no, se generan 22 rutas sintéticas plausibles que incluyan el par de calles paralelas del centro.
2. Los paraderos se modelan como puntos con `id, ruta, orden, metros_desde_inicio, cupo`.
3. La frecuencia programada por ruta y franja se configura como tabla JSON.
4. El simulador actúa como servidor WebSocket local (o `MessageChannel` en página) que el cliente consume igual que un backend real.

## Open Questions
- [ ] ¿Se entrega un archivo real de cartografía JSON o generamos una red sintética con calles paralelas?
- [ ] ¿Se prefiere Vite con vanilla JS/TS o se permite una librería UI (React)? (Por RT-7 y RT-10 vanilla sobre Vite suele dar más control para el renderizado canvas y el control del hilo).
- [ ] ¿Teselas de mapa (Mapbox/OSM) o dibujar las rutas directamente sobre canvas sin teselas para evitar el costo y problemas de COEP?

## Acceptance Criteria

### AC-1: Índice espacial responde en acotado por consulta
- **Type**: `rule`
- **Given**: Aplicación cargada con 22 rutas y ~40.000 vértices indexados
- **When**: Se consultan 10.000 posiciones aleatorias contra el índice con radio de 80 m
- **Then**: El percentil 95 de tiempo por consulta es ≤ 0,1 ms y el total de memoria del índice es ≤ 5 MB
- **Pass Condition**: Benchmark interno adentro de la app (panel Performance) reporta P95 ≤ 0,1 ms y heap ≤ 5 MB
- **Evidence**: Captura del panel de métricas de la aplicación + log de consola

### AC-2: Asignación a vía correcta — calle paralela
- **Type**: `rule`
- **Given**: El trayecto de prueba etiquetado sobre las dos calles paralelas
- **When**: Se reproduce el trayecto por el pipeline y se cuentan los cambios de calle falsos
- **Then**: Cambios falsos < 3 (la línea base de vecino más cercano produce 15–30)
- **Pass Condition**: Pantalla de validación del trayecto con conteo de aciertos y cambios falsos < 3
- **Evidence**: Log del validador + captura de la pantalla de prueba etiquetada

### AC-3: Posición monótona sin retrocesos espurios
- **Type**: `rule`
- **Given**: 310 buses simulados incluyendo 3 % de mensajes fuera de orden
- **When**: Se analiza la serie de `metros_desde_inicio` de cada bus durante 10 min
- **Then**: Ningún retroceso excede 5 m salvo el bus que realmente retrocede (y se marca como `estimated` tras huecos)
- **Pass Condition**: Prueba del simulador con detector de retrocesos; 0 retrocesos espurios > 5 m
- **Evidence**: Log de simulación + panel de estado por bus con marca `estimated`

### AC-4: Percentiles en flujo estables
- **Type**: `rule`
- **Given**: Una hora de simulación con tramos recorridos en condiciones normales
- **When**: Se compara la mediana y P85 online con los mismos percentiles calculados “batch” sobre las mismas observaciones
- **Then**: Error relativo < 5 % en ambos percentiles, por tramo y franja
- **Pass Condition**: Verificación por lote guardado vs valor online
- **Evidence**: Archivo JSON de comparación percentiles online vs batch

### AC-5: Bunching detectado antes de la pareja
- **Type**: `rule`
- **Given**: Escenario reproducible de bunching forzado por el simulador
- **When**: Se corre la simulación y se registra el instante de la alerta vs el instante en que el intervalo cae por debajo del 40 % del programado
- **Then**: La alerta se emite con al menos 120 s de antelación
- **Pass Condition**: Línea de tiempo del escenario: `t_alerta + 120 s ≤ t_bunching_real`
- **Evidence**: Registro del escenario de bunching reproducible con timestamps

### AC-6: Retención no genera hueco > 160 % ni excede cupo
- **Type**: `rule`
- **Given**: Un escenario con riesgo de bunching y cupo limitado en paradero compartido
- **When**: El sistema emite recomendaciones de retención
- **Then**: (1) Ningún hueco posterior excede el 160 % del programado; (2) en ningún paradero coinciden simultáneamente más buses retenidos que su cupo físico; (3) conflictos se resuelven con el criterio documentado
- **Pass Condition**: Reporte del simulador en modo auditor con comprobaciones (1) (2) (3)
- **Evidence**: Log de auditoría del escenario con retención

### AC-7: IPI ≤ 200 ms arrastrando slider, 310 buses
- **Type**: `rule`
- **Given**: Chrome DevTools con throttling CPU 4x, reproducción histórica con 2 h de datos
- **When**: Se arrastra el control deslizante de tiempo continuamente durante 30 s
- **Then**: El IPI medido por PerformanceObserver, P95 ≤ 200 ms; sin long tasks > 50 ms
- **Pass Condition**: Captura del Performance panel del navegador con P95(IPI) ≤ 200 ms
- **Evidence**: Traza de Performance descargada o screenshot del panel

### AC-8: Offline abre y reenvía acciones
- **Type**: `rule`
- **Given**: App cargada una vez, luego se desconecta la red
- **When**: (1) Se recarga la página sin red y (2) el supervisor registra 3 acciones offline y luego (3) se recupera la red
- **Then**: (1) La app abre y muestra el último estado con su timestamp; (2) las 3 acciones quedan en cola local; (3) al recuperar red, las acciones se envían sin reintento manual y el usuario ve confirmación
- **Pass Condition**: Paso manual con DevTools offline checkbox + log de Service Worker
- **Evidence**: Video corto o secuencia de screenshots del flujo offline

### AC-9: SharedArrayBuffer sin tears ni wait en principal
- **Type**: `rule`
- **Given**: Código fuente del cliente
- **When**: (1) Se revisa el hilo principal en busca de `Atomics.wait` y (2) se corre una simulación 30 min con chequeos de consistencia por lectura de versión
- **Then**: (1) 0 apariciones de `Atomics.wait` en archivos que corren en el hilo principal; (2) 0 lecturas con versión/CRC inconsistentes durante 30 min
- **Pass Condition**: `grep -R "Atomics.wait" src` vacío en módulos main; log de detector de tears todo en cero
- **Evidence**: Output del grep + log de consistencia

### AC-10: Simulador emite 310 buses con realidades del dato
- **Type**: `rule`
- **Given**: Simulador arrancado con seed fijo
- **When**: Se recolectan 5 min de mensajes y se valida cada fenómeno
- **Then**: (a) 310 buses únicos presentes; (b) error espacial 8–15 m fuera del centro, ≤ 60 m en centro; (c) silencios 40 s–4 min en ~5–10 % de buses por ventana; (d) desfase de reloj ±90 s uniforme; (e) ~3 % de mensajes llegan fuera de orden; (f) escenario de bunching forzado idéntico entre runs con mismo seed
- **Pass Condition**: Log de estadísticas del simulador con cada métrica dentro de rango; reproducción idéntica con mismo seed
- **Evidence**: Archivo stats.json del simulador + checksum del stream con seed fijo

### AC-11: crossOriginIsolated y despliegue público
- **Type**: `rule`
- **Given**: URL pública de la aplicación
- **When**: Abrir la URL y ejecutar `crossOriginIsolated` en consola
- **Then**: `crossOriginIsolated === true` y la URL responde sin credenciales del autor
- **Pass Condition**: Screenshot de la consola mostrando `crossOriginIsolated = true` + URL pública funcional
- **Evidence**: URL publicada + captura de consola

### AC-12: Calidad de la asignación en trayecto etiquetado
- **Type**: `rubric`
- **Dimension**: Precisión y estabilidad de la asignación de vía sobre el trayecto etiquetado de calles paralelas
- **Scale**: 1–5
- **Anchors**:
  - 1 = ≥15 cambios falsos (igual a vecino más cercano)
  - 3 = 3–5 cambios falsos, con ocasionales saltos en intersecciones
  - 5 = 0–2 cambios falsos, transiciones estables, y el informe explica exactamente qué término del criterio lo logra
- **Pass Threshold**: >= 4
- **Evidence**: Informe de validación del trayecto + explicación del criterio en README

### AC-13: Arquitectura de workers correctamente separada
- **Type**: `rubric`
- **Dimension**: Correcto reparto de trabajo entre Web Worker / Shared Worker / Service Worker, y justificación en README (RT-9)
- **Scale**: 1–5
- **Anchors**:
  - 1 = todo corre en el hilo principal o la explicación es incorrecta
  - 3 = geometría en Web Worker pero falta justificar por qué no va a otro tipo; offline incompleto
  - 5 = cada tipo usado en el lugar correcto con justificación precisa y sin intercambios incorrectos
- **Pass Threshold**: >= 4
- **Evidence**: README sección explicando tipos de Worker + auditoría de código

### AC-14: SMOF del mapa — descartes y rendimiento
- **Type**: `rubric`
- **Dimension**: Eficiencia del render en canvas: culling por viewport, sin elementos DOM por bus, sin setInterval, uso estricto de requestAnimationFrame
- **Scale**: 1–5
- **Anchors**:
  - 1 = usa setInterval o crea marcadores DOM por bus; sin culling
  - 3 = requestAnimationFrame + canvas pero falta culling o hay long tasks ocasionales
  - 5 = culling estricto, estelas con descarte progresivo, 0 long tasks > 50 ms bajo CPU 4x
- **Pass Threshold**: >= 4
- **Evidence**: Traza de Performance del navegador + revisión de código

### AC-15: README explica camino GPS → alerta
- **Type**: `rubric`
- **Dimension**: Claridad, técnica y completitud del README al explicar el camino de una posición GPS desde su llegada hasta la alerta
- **Scale**: 1–5
- **Anchors**:
  - 1 = falta explicación o es superficial
  - 3 = describe las etapas pero omite detalles de ordenamiento, memoria de secuencia, versionado de búfer o umbrales de alerta
  - 5 = diagrama textual o flujo paso a paso, menciona cada estructura de datos y su costo, responde preguntas P-4 y P-8 implícitas de RT-2 y RT-9
- **Pass Threshold**: >= 4
- **Evidence**: Sección del README “GPS path to alert”
