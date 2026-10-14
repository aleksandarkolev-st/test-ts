// Space UI primitive wrappers, adapted to local CSS; see THIRD_PARTY_NOTICES.md.
import { Tabs as Primitive } from '@base-ui/react/tabs';

export function Tabs(props: Primitive.Root.Props) {
  return <Primitive.Root data-slot="tabs" {...props} />;
}
export function TabsList({ children, ...props }: Primitive.List.Props) {
  return <Primitive.List activateOnFocus className="setup-nav" data-slot="tabs-list" {...props}>
    {children}<Primitive.Indicator className="setup-tab-indicator" data-slot="tab-indicator" />
  </Primitive.List>;
}
export function TabsTab(props: Primitive.Tab.Props) {
  return <Primitive.Tab data-slot="tabs-tab" {...props} />;
}
export function TabsPanel(props: Primitive.Panel.Props) {
  return <Primitive.Panel data-slot="tabs-content" keepMounted {...props} />;
}
