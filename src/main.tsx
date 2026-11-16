import { createRoot } from 'react-dom/client';
import App from './App';
import PackApp from './v2/PackApp';
import BlueprintApp from './bp/BlueprintApp';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
const root = createRoot(el);
const render = () => {
  if (location.hash === '#v1') root.render(<App />);
  else if (location.hash === '#v2') root.render(<PackApp />);
  else root.render(<BlueprintApp />);
};
render();
window.addEventListener('hashchange', render);
