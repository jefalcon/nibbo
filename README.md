# Nibbo

Juego arcade original de laberinto para navegador. Nibbo, un bichito-farol,
recorre un jardín de setos comiendo semillas de luz mientras cuatro polillas
de sombra lo cazan, cada una con su propia IA:

- **Umbra**: persigue directamente tu casilla.
- **Vela**: intenta anticiparse (apunta 4 casillas por delante de tu dirección).
- **Petra**: patrulla sus esquinas en ciclo.
- **Fusa**: se mueve de forma errática.

Las 4 semillas grandes asustan a las polillas unos segundos: huyen y puedes
comerlas (200 → 400 → 800 → 1600 puntos en cadena).

## Cómo arrancarlo (offline, sin instalar nada)

Opción 1 — abrir el archivo (tal cual, funciona offline):

- Haz doble clic en `index.html` o ábrelo con el navegador desde la carpeta del repo.

Opción 2 — servidor local (solo si prefieres `http://`):

```sh
python3 -m http.server 8080
# abre http://localhost:8080 en el navegador
```

Sin dependencias, sin assets externos: arte en canvas y sonido con WebAudio.

## Controles

- Teclado: flechas o WASD para moverte, **P** pausa, **Enter** empezar.
- Móvil: swipe para moverte, toque corto para empezar/seguir.
- Túnel lateral en la fila central: salir por un lado entra por el otro.

Vidas (3 + extra a los 10000), puntuación, récord en `localStorage`
y niveles que aceleran (las polillas corren más y la huida dura menos).

## Lógica y tests

La lógica pura (rejilla, colisiones, IA de cada polilla, puntuación, niveles)
vive en `logic.js`, sin DOM, y se prueba con `node:test`:

```sh
npm test
# o: node --test tests/logic.test.js
```
