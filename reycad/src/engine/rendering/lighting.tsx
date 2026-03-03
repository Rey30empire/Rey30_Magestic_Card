type SceneLightingProps = {
  shadows: boolean;
};

export function SceneLighting({ shadows }: SceneLightingProps): JSX.Element {
  return (
    <>
      <ambientLight intensity={0.5} />
      <directionalLight position={[12, 16, 9]} intensity={1.2} castShadow={shadows} />
      <directionalLight position={[-8, 10, -10]} intensity={0.55} />
    </>
  );
}
