import { createRoot } from 'react-dom/client';
import BlueprintApp from './bp/BlueprintApp';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(<BlueprintApp />);
