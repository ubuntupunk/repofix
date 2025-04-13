// types/blessed.d.ts
import 'blessed';

declare module 'blessed' {
  namespace Widgets {
    interface ListElement {
      selected: number;
    }
  }
}