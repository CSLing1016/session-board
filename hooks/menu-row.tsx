import type { ClientSurface } from 'claude-code'

// One row of the ☰ menu, because a Button on the desktop always keeps its own gray.
export default function MenuRow(props: { label: string; isQuiet?: boolean }, surface: ClientSurface<boolean>) {
  const { Box, Text } = surface.elements
  surface.onPointer(event => {
    if (event.type === 'enter') surface.setState(true)
    if (event.type === 'leave') surface.setState(false)
    if (event.type === 'up') surface.post('picked')
  })

  return (
    <Box justifyContent="center" backgroundColor={surface.state && !props.isQuiet ? '#ffffff18' : undefined}>
      <Text>{props.label}</Text>
    </Box>
  )
}
