# Motor de Cartas v1 - Reglas Deterministas

## Endpoint
- `POST /api/duels/engine/simulate`

## Determinismo
- El resultado depende de:
  - `seed`
  - mazos de entrada (`left.cards`, `right.cards`)
  - `maxTurns`
- Misma entrada => mismo resultado siempre.

## Pipeline por turno
1. Selección de unidad activa por lado (primera viva).
2. Start-turn effects:
   - `regen`: cura +1.
   - `legend-heart`: cura +1 adicional bajo 40% de HP.
3. Cálculo de iniciativa:
   - `speed + rarityBonus + quick-step + rollDeterminista`.
4. Ataques en orden de iniciativa.
5. Resolución de daño:
   - base por ataque, defensa, rareza y variación determinista.
   - `pierce` reduce impacto de defensa.
   - `shield` reduce daño recibido.
   - `berserk` aumenta daño bajo 50% HP.
   - `fury` escala daño por turno.
   - `lifesteal` cura porcentaje del daño infligido.
6. KO y cambio automático de unidad activa.

## Condición de victoria
- Si un lado se queda sin unidades vivas: gana el otro.
- Si ambos sobreviven al límite de turnos:
  - gana el lado con mayor HP total.
  - empate si HP total es igual.

## Salida relevante
- `winner`: `left | right | draw`
- `turns`
- `timeline`: eventos detallados por turno
- `summary`: unidades restantes y HP total por lado
