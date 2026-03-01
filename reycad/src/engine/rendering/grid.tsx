type GridProps = {
  size: number;
};

export function SceneGrid({ size }: GridProps): JSX.Element {
  return <gridHelper args={[size, size / 5, "#54657a", "#2d3540"]} position={[0, 0, 0]} />;
}
