import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet-draw';
import * as turf from '@turf/turf';
import localforage from 'localforage';
import { 
  Layers, Navigation, Undo, Redo, Maximize,
  PenSquare, List, Database, Info, X, 
  Map as MapIcon, Route, MapPin, Circle,
  Edit2, Trash2, Download, Upload, Compass,
  Leaf, Satellite
} from 'lucide-react';

const STORAGE_KEY = 'landmapper_react_data';
const MAX_HISTORY = 50;
const TEA_PLANTS_PER_HECTARE = 13000;
const baseLayers = {
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
  terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17 })
};

export default function App() {
  const mapRef = useRef(null);
  const drawnItemsRef = useRef(null);
  const drawControlRef = useRef(null);
  const locationMarkerRef = useRef(null);
  const locationCircleRef = useRef(null);
  const watchIdRef = useRef(null);

  // States
  const [loading, setLoading] = useState(true);
  const [activeTray, setActiveTray] = useState(null);
  const [layers, setLayers] = useState([]);
  const [measurements, setMeasurements] = useState({ area: null, perimeter: null });
  const [gpsData, setGpsData] = useState({ lat: 0, lng: 0, accuracy: 0, samples: 0, status: 'Locating' });
  const [compassHeading, setCompassHeading] = useState(null);
  const [followUser, setFollowUser] = useState(true);
  const [currentBaseLayer, setCurrentBaseLayer] = useState('satellite');
  const [activeDrawTool, setActiveDrawTool] = useState(null);
  const [areaUnit, setAreaUnit] = useState('metric');
  const [distUnit, setDistUnit] = useState('metric');
  const [history, setHistory] = useState({ undoStack: [], redoStack: [] });

  const lastPositionRef = useRef(null);
  const gpsHistoryRef = useRef([]);

  // Setup Map
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map('map', {
      center: [0, 0],
      zoom: 2,
      zoomControl: false,
      tap: true 
    });
    mapRef.current = map;

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    baseLayers.satellite.addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawnItemsRef.current = drawnItems;

    const drawControl = new L.Control.Draw({
      draw: false,
      edit: {
        featureGroup: drawnItems,
        remove: true,
        edit: {}
      }
    });
    drawControlRef.current = drawControl;

    map.on('mousemove', () => {});
    map.on('click', () => setActiveTray(null));
    map.on('dragstart', () => {
      setFollowUser(prev => {
        if (prev) return false;
        return prev;
      });
    });

    map.on('draw:created', handleDrawCreated);
    map.on('draw:edited', handleDrawEdited);
    map.on('draw:deleted', handleDrawDeleted);

    loadOfflineData().then(() => {
      startLocationTracking();
    });

    return () => {
      if (watchIdRef.current) navigator.geolocation.clearWatch(watchIdRef.current);
      window.removeEventListener('deviceorientationabsolute', handleCompass);
      window.removeEventListener('deviceorientation', handleCompass);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const totalArea = layers.reduce((acc, layerInfo) => {
    if (layerInfo.type === 'polygon' || layerInfo.type === 'rectangle') {
      const layer = drawnItemsRef.current.getLayer(layerInfo.id);
      if (layer) {
        const latlngs = layer.getLatLngs()[0];
        const coords = latlngs.map(ll => [ll.lng, ll.lat]);
        coords.push(coords[0]);
        acc += turf.area(turf.polygon([coords]));
      }
    }
    return acc;
  }, 0);

  const calculateMeasurements = (layer) => {
    let area = null, perimeter = null;
    if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
      const coords = layer.getLatLngs()[0].map(ll => [ll.lng, ll.lat]);
      coords.push(coords[0]);
      area = turf.area(turf.polygon([coords]));
      perimeter = turf.length(turf.lineString(coords), { units: 'meters' }) * 1000;
    } else if (layer instanceof L.Polyline) {
      const coords = layer.getLatLngs().map(ll => [ll.lng, ll.lat]);
      perimeter = turf.length(turf.lineString(coords), { units: 'meters' }) * 1000;
    } else if (layer instanceof L.Circle) {
      const radius = layer.getRadius();
      area = Math.PI * radius * radius;
      perimeter = 2 * Math.PI * radius;
    }
    setMeasurements({ area, perimeter });
  };

  const handleDrawCreated = (e) => {
    const { layer, layerType } = e;
    saveStateForUndo();
    drawnItemsRef.current.addLayer(layer);
    
    const layerId = L.stamp(layer);
    const layerInfo = {
      id: layerId,
      type: layerType,
      name: `${layerType.charAt(0).toUpperCase() + layerType.slice(1)} ${layers.length + 1}`,
      timestamp: new Date().toISOString(),
      gpsAccuracy: typeof gpsData.accuracy === 'number' ? gpsData.accuracy.toFixed(1) : '-'
    };
    
    setLayers(prev => [...prev, layerInfo]);
    calculateMeasurements(layer);
    
    layer.bindPopup(`
      <div class="p-2">
        <strong>${layerInfo.name}</strong><br>
        <small>Created: ${new Date(layerInfo.timestamp).toLocaleString()}</small><br>
        <small>Accuracy: ${layerInfo.gpsAccuracy}m</small>
      </div>
    `);

    saveOfflineData();
    setActiveDrawTool(null);
    setActiveTray(null);
  };

  const handleDrawEdited = (e) => {
    saveStateForUndo();
    e.layers.eachLayer(layer => calculateMeasurements(layer));
    saveOfflineData();
    setLayers([...layers]);
  };

  const handleDrawDeleted = (e) => {
    saveStateForUndo();
    const deletedIds = [];
    e.layers.eachLayer(layer => deletedIds.push(L.stamp(layer)));
    setLayers(prev => prev.filter(l => !deletedIds.includes(l.id)));
    setMeasurements({ area: null, perimeter: null });
    saveOfflineData();
  };

  const toggleBaseMap = () => {
    const maps = ['osm', 'satellite', 'terrain'];
    const nextLayer = maps[(maps.indexOf(currentBaseLayer) + 1) % maps.length];
    mapRef.current.removeLayer(baseLayers[currentBaseLayer]);
    baseLayers[nextLayer].addTo(mapRef.current);
    setCurrentBaseLayer(nextLayer);
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else if (document.exitFullscreen) document.exitFullscreen();
  };

  const startDrawing = (type) => {
    setActiveDrawTool(type);
    let handler;
    const map = mapRef.current;
    const opts = typeof drawControlRef.current.options.draw === 'object' ? drawControlRef.current.options.draw : {};
    switch (type) {
      case 'polygon': handler = new L.Draw.Polygon(map, opts.polygon || {}); break;
      case 'polyline': handler = new L.Draw.Polyline(map, opts.polyline || {}); break;
      case 'marker': handler = new L.Draw.Marker(map, opts.marker || {}); break;
      case 'circle': handler = new L.Draw.Circle(map, opts.circle || {}); break;
    }
    if (handler) {
      handler.enable();
      setActiveTray(null);
    }
  };

  const editLayers = () => {
    if (drawControlRef.current._map) {
      mapRef.current.removeControl(drawControlRef.current);
    } else {
      mapRef.current.addControl(drawControlRef.current);
    }
  };

  const clearLayers = () => {
    if (window.confirm('Delete all layers? This cannot be undone.')) {
      saveStateForUndo();
      drawnItemsRef.current.clearLayers();
      setLayers([]);
      setMeasurements({ area: null, perimeter: null });
      saveOfflineData();
    }
  };

  const saveStateForUndo = () => {
    const currentState = {
      layersDrawn: drawnItemsRef.current.toGeoJSON(),
      layersInfo: layers
    };
    setHistory(prev => {
      const newUndo = [...prev.undoStack, currentState].slice(-MAX_HISTORY);
      return { undoStack: newUndo, redoStack: [] };
    });
  };

  const undoAction = () => {
    if (history.undoStack.length === 0) return;
    const currentState = {
      layersDrawn: drawnItemsRef.current.toGeoJSON(),
      layersInfo: layers
    };
    const newUndo = [...history.undoStack];
    const prevState = newUndo.pop();
    
    setHistory(prev => ({
      undoStack: newUndo,
      redoStack: [...prev.redoStack, currentState]
    }));
    restoreState(prevState);
  };

  const redoAction = () => {
    if (history.redoStack.length === 0) return;
    const currentState = {
      layersDrawn: drawnItemsRef.current.toGeoJSON(),
      layersInfo: layers
    };
    const newRedo = [...history.redoStack];
    const nextState = newRedo.pop();
    
    setHistory(prev => ({
      undoStack: [...prev.undoStack, currentState],
      redoStack: newRedo
    }));
    restoreState(nextState);
  };

  const restoreState = (state) => {
    drawnItemsRef.current.clearLayers();
    setLayers([]);
    if (state.layersDrawn?.features) {
      L.geoJSON(state.layersDrawn, {
        onEachFeature: (feature, layer) => {
          drawnItemsRef.current.addLayer(layer);
          const restored = state.layersInfo.find(l => l.name === feature.properties?.name);
          if (restored) setLayers(prev => [...prev, { ...restored, id: L.stamp(layer) }]);
        }
      });
    }
    saveOfflineData();
  };

  const saveOfflineData = async () => {
    try {
      drawnItemsRef.current.eachLayer(layer => {
        const info = layers.find(l => l.id === L.stamp(layer));
        if (info) {
          layer.feature = layer.feature || { type: 'Feature', properties: {} };
          layer.feature.properties = { ...info };
        }
      });
      await localforage.setItem(STORAGE_KEY, drawnItemsRef.current.toGeoJSON());
    } catch (err) { console.error(err); }
  };

  const loadOfflineData = async () => {
    try {
      const data = await localforage.getItem(STORAGE_KEY);
      if (data && data.features?.length > 0) {
        L.geoJSON(data, {
          onEachFeature: (feature, layer) => {
            drawnItemsRef.current.addLayer(layer);
            const props = feature.properties || {};
            const type = props.type || (feature.geometry.type.includes('Polygon') ? 'polygon' : 'marker');
            const layerInfo = {
              id: L.stamp(layer),
              type,
              name: props.name || `Layer ${layers.length + 1}`,
              timestamp: props.timestamp || new Date().toISOString(),
              gpsAccuracy: props.gpsAccuracy || '-'
            };
            setLayers(prev => [...prev, layerInfo]);
          }
        });
      }
    } catch (err) { console.error(err); }
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const geojson = JSON.parse(event.target.result);
        L.geoJSON(geojson, {
          onEachFeature: (feature, layer) => {
            drawnItemsRef.current.addLayer(layer);
            setLayers(prev => [...prev, {
              id: L.stamp(layer),
              type: 'imported',
              name: `Imported ${prev.length + 1}`,
              timestamp: new Date().toISOString(),
              gpsAccuracy: '-'
            }]);
          }
        });
        saveOfflineData();
        mapRef.current.fitBounds(drawnItemsRef.current.getBounds());
      } catch (err) { alert('Invalid GeoJSON'); }
    };
    reader.readAsText(file);
  };

  const handleExport = async () => {
    saveOfflineData();
    const data = drawnItemsRef.current.toGeoJSON();
    const str = JSON.stringify(data, null, 2);
    const blob = new Blob([str], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `landmapper_${Date.now()}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCompass = (e) => {
    let heading;
    if (e.webkitCompassHeading) heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) heading = 360 - e.alpha;
    else if (e.alpha !== null) heading = 360 - e.alpha;
    if (heading !== undefined) setCompassHeading(Math.round(heading));
  };

  const startLocationTracking = () => {
    if (!navigator.geolocation) {
      setLoading(false);
      return alert('Geolocation not supported');
    }
    // Strict constraints: require High Accuracy, do not cache (maximumAge: 0), force frequent fresh polling
    const opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
    navigator.geolocation.getCurrentPosition(updatePosition, () => setLoading(false), opts);
    watchIdRef.current = navigator.geolocation.watchPosition(updatePosition, () => {}, opts);
    
    if (window.DeviceOrientationEvent) {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(res => {
          if (res === 'granted') window.addEventListener('deviceorientation', handleCompass, true);
        }).catch(err => console.log(err));
      } else {
        window.addEventListener('deviceorientationabsolute', handleCompass, true);
        window.addEventListener('deviceorientation', handleCompass, true);
      }
    }
  };

  const updatePosition = (pos) => {
    setLoading(false);
    const { latitude: lat, longitude: lng, accuracy: rawAcc } = pos.coords;
    
    // STRICT ACCURACY FILTER: Ignore readings with >15m accuracy unless we have no history
    if (rawAcc > 15 && gpsHistoryRef.current.length > 0) return;

    gpsHistoryRef.current.push({ lat, lng, accuracy: rawAcc, ts: Date.now() });
    // Keep a slightly longer history table for better smoothing
    if (gpsHistoryRef.current.length > 8) gpsHistoryRef.current.shift();
    
    let weightedLat = 0, weightedLng = 0, totalWeight = 0, minAcc = rawAcc;
    
    // Improved Kalman-style weighted averaging
    if (rawAcc >= 3) {
      gpsHistoryRef.current.forEach(p => {
        // Punish low accuracy exponentially so accurate points pull coordinate tighter
        const w = 1 / Math.pow(p.accuracy, 2); 
        totalWeight += w;
        weightedLat += p.lat * w;
        weightedLng += p.lng * w;
        minAcc = Math.min(minAcc, p.accuracy);
      });
      weightedLat /= totalWeight;
      weightedLng /= totalWeight;
    } else {
      // Sub-3m accuracy is considered "Ground Truth"
      weightedLat = lat; 
      weightedLng = lng;
    }

    lastPositionRef.current = [weightedLat, weightedLng];
    
    setGpsData({
      lat: weightedLat, lng: weightedLng,
      accuracy: minAcc,
      samples: gpsHistoryRef.current.length,
      status: minAcc < 3 ? 'Excellent' : minAcc < 8 ? 'Good' : minAcc < 15 ? 'Fair' : 'Poor'
    });

    if (!locationMarkerRef.current && mapRef.current) {
      locationMarkerRef.current = L.marker([weightedLat, weightedLng], {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: '<div style="background: #4285F4; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transform: translate(-2px, -2px);"></div>',
          iconSize: [16, 16]
        }),
        zIndexOffset: 1000
      }).addTo(mapRef.current);
      locationCircleRef.current = L.circle([weightedLat, weightedLng], {
        radius: minAcc, color: '#4285F4', fillOpacity: 0.1, weight: 1
      }).addTo(mapRef.current);
    } else if (locationMarkerRef.current) {
      locationMarkerRef.current.setLatLng([weightedLat, weightedLng]);
      locationCircleRef.current.setLatLng([weightedLat, weightedLng]);
      locationCircleRef.current.setRadius(minAcc);
    }

    setFollowUser(prev => {
      if (prev && mapRef.current) {
        if (mapRef.current.getZoom() < 10) mapRef.current.setView([weightedLat, weightedLng], 18);
        else mapRef.current.panTo([weightedLat, weightedLng]);
      }
      return prev;
    });
  };

  const toggleLocationFollow = () => {
    if (!lastPositionRef.current) return alert('Waiting for GPS signal...');
    if (!followUser) mapRef.current.setView(lastPositionRef.current, 18);
    setFollowUser(true);
  };

  const convertArea = (sqm) => {
    if (areaUnit === 'imperial') {
      const sqft = sqm * 10.7639;
      return sqft > 43560 ? `${(sqft / 43560).toFixed(2)} ac` : `${sqft.toFixed(0)} ft²`;
    }
    return sqm > 10000 ? `${(sqm / 10000).toFixed(2)} ha` : `${sqm.toFixed(2)} m²`;
  };

  const convertDist = (m) => {
    if (distUnit === 'imperial') {
      const ft = m * 3.28084;
      return ft > 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${ft.toFixed(0)} ft`;
    }
    return m > 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(2)} m`;
  };

  const handleMenuClick = (tray) => setActiveTray(prev => prev === tray ? null : tray);

  return (
    <div className="relative w-full h-screen overflow-hidden text-gray-800 bg-gray-100 font-sans touch-manipulation">
      {loading && (
        <div id="loadingOverlay">
          <div className="spinner mb-4"></div>
          <div className="text-gray-700 font-medium">Locating...</div>
          <div className="text-xs text-gray-500 mt-2">Waiting for GPS signal</div>
        </div>
      )}

      <div id="map" className="w-full h-full absolute top-0 left-0 z-0"></div>

      <div className="coordinates-display">
        <div className="font-semibold text-gray-700 mb-1 text-[10px] uppercase tracking-wider">GPS Data</div>
        <div className="text-[10px] text-gray-600 font-mono">
          <div><span className="text-gray-400">Lat:</span> {gpsData.lat.toFixed(7)}</div>
          <div><span className="text-gray-400">Lng:</span> {gpsData.lng.toFixed(7)}</div>
          <div><span className="text-gray-400">Acc:</span> {gpsData.accuracy.toFixed(1)}m</div>
          {compassHeading !== null && (
            <div className="mt-1 flex items-center gap-1 text-[11px]">
              <Compass size={12} className="text-blue-500" /> {compassHeading}°
            </div>
          )}
        </div>
      </div>

      {compassHeading !== null && (
        <div className="compass-widget">
          <div className="compass-label">N</div>
          <Compass 
            size={24} 
            className="text-red-500 transition-transform" 
            style={{ transform: `rotate(${-compassHeading}deg)` }} 
          />
        </div>
      )}

      {(measurements.area !== null || measurements.perimeter !== null) && (
        <div className="measurement-pill">
          {measurements.area !== null && (
            <span className="border-r border-gray-300 pr-3 mr-3 flex items-center gap-2">
              <MapIcon size={16} className="text-indigo-600" />
              {convertArea(measurements.area)}
            </span>
          )}
          {measurements.perimeter !== null && (
            <span className="flex items-center gap-2">
              <Route size={16} className="text-indigo-600" />
              {convertDist(measurements.perimeter)}
            </span>
          )}
        </div>
      )}

      <div className="fixed top-4 left-4 z-[1000] flex flex-col gap-2 no-select">
        <button onClick={toggleBaseMap} className="bg-white/90 backdrop-blur w-10 h-10 rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-gray-100 flex items-center justify-center active:scale-95 transition-all">
          <Layers size={20} className="text-gray-700" />
        </button>
        <button onClick={toggleLocationFollow} className={`bg-white/90 backdrop-blur w-10 h-10 rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-gray-100 flex items-center justify-center active:scale-95 transition-all ${followUser ? 'text-indigo-600 bg-indigo-50 border-indigo-200' : 'text-gray-700'}`}>
          <Navigation size={20} />
        </button>
        <button onClick={undoAction} disabled={history.undoStack.length === 0} className="bg-white/90 backdrop-blur w-10 h-10 rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-gray-100 flex items-center justify-center active:scale-95 transition-all disabled:opacity-50">
          <Undo size={18} className="text-gray-700" />
        </button>
        <button onClick={redoAction} disabled={history.redoStack.length === 0} className="bg-white/90 backdrop-blur w-10 h-10 rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-gray-100 flex items-center justify-center active:scale-95 transition-all disabled:opacity-50">
          <Redo size={18} className="text-gray-700" />
        </button>
        <button onClick={toggleFullscreen} className="bg-white/90 backdrop-blur w-10 h-10 rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-gray-100 flex items-center justify-center active:scale-95 transition-all mt-2">
          <Maximize size={18} className="text-gray-700" />
        </button>
      </div>

      <div className={`tool-tray ${activeTray === 'draw' ? 'active' : ''}`}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-800">Drawing Tools</h3>
          <button onClick={() => setActiveTray(null)}><X size={20} className="text-gray-400" /></button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[
            { id: 'polygon', icon: <PenSquare/>, label: 'Area', color: 'blue' },
            { id: 'polyline', icon: <Route/>, label: 'Line', color: 'green' },
            { id: 'marker', icon: <MapPin/>, label: 'Point', color: 'red' },
            { id: 'circle', icon: <Circle/>, label: 'Circle', color: 'purple' }
          ].map(tool => (
            <button key={tool.id} onClick={() => startDrawing(tool.id)}
              className={`flex flex-col items-center p-2 rounded-xl transition-all border ${activeDrawTool === tool.id ? `bg-${tool.color}-50 border-${tool.color}-200` : 'bg-gray-50 border-transparent active:bg-gray-100'}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center mb-1 ${activeDrawTool === tool.id ? `bg-${tool.color}-500 text-white` : `bg-${tool.color}-100 text-${tool.color}-600`}`}>
                {tool.icon}
              </div>
              <span className="text-xs font-medium text-gray-600">{tool.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-3">
          <button onClick={editLayers} className="flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium active:bg-gray-200">
            <Edit2 size={16} /> Edit Mode
          </button>
          <button onClick={clearLayers} className="flex items-center justify-center gap-2 px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-medium active:bg-red-100">
            <Trash2 size={16} /> Clear All
          </button>
        </div>
      </div>

      <div className={`tool-tray ${activeTray === 'layers' ? 'active' : ''}`}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-800">Layers</h3>
          <div className="text-xs text-gray-500 font-medium bg-gray-100 px-2 py-1 rounded">{layers.length} features</div>
          <button onClick={() => setActiveTray(null)}><X size={20} className="text-gray-400" /></button>
        </div>
        <div className="max-h-56 overflow-y-auto pr-2 space-y-2">
          {layers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <Layers size={32} className="mb-2 opacity-50" />
              <span className="text-sm">No plantation plots yet</span>
            </div>
          ) : (
            layers.map((l, idx) => (
              <div key={l.id} className="bg-white border border-gray-100 shadow-sm p-3 rounded-xl flex justify-between items-center">
                <div>
                  <div className="text-sm font-semibold text-gray-800 flex items-center gap-1">
                    {l.name}
                    {(l.type === 'polygon' || l.type === 'rectangle') && <Leaf size={12} className="text-emerald-500" />}
                  </div>
                  <div className="text-xs text-gray-400 space-x-2">
                    <span>{new Date(l.timestamp).toLocaleTimeString()}</span>
                    <span>•</span>
                    <span>Acc: {l.gpsAccuracy}m</span>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-gray-50 text-gray-500 rounded-md border border-gray-100">{l.type}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className={`tool-tray ${activeTray === 'data' ? 'active' : ''}`}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-800">Data Management</h3>
          <button onClick={() => setActiveTray(null)}><X size={20} className="text-gray-400" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button onClick={handleExport} className="p-4 bg-white border border-gray-100 shadow-sm rounded-2xl flex flex-col items-center active:scale-95 transition-all">
            <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mb-2">
              <Download size={24} />
            </div>
            <span className="font-semibold text-gray-700">Export</span>
            <span className="text-[10px] text-gray-400">Save as GeoJSON</span>
          </button>
          <label className="p-4 bg-white border border-gray-100 shadow-sm rounded-2xl flex flex-col items-center active:scale-95 transition-all cursor-pointer">
            <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mb-2">
              <Upload size={24} />
            </div>
            <span className="font-semibold text-gray-700">Import</span>
            <span className="text-[10px] text-gray-400">Load GeoJSON</span>
            <input type="file" className="hidden" accept=".geojson,.json" onChange={handleImport} />
          </label>
        </div>
      </div>

      <div className={`tool-tray ${activeTray === 'info' ? 'active' : ''}`} style={{ maxHeight: '75vh', overflowY: 'auto' }}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-gray-800">Analytics & Settings</h3>
          <button onClick={() => setActiveTray(null)}><X size={20} className="text-gray-400" /></button>
        </div>

        <div className="tea-plantation-badge flex items-center justify-center gap-1 mx-auto w-max mb-4">
          <Leaf size={12} /> Tea Plantation Mapper
        </div>

        <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-2xl p-5 text-white shadow-lg mb-5 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white opacity-5 rounded-full -mr-10 -mt-10"></div>
          <div className="text-xs text-indigo-200 uppercase tracking-widest font-semibold mb-1">Total Plantation Area</div>
          <div className="text-3xl font-black tracking-tight">{convertArea(totalArea)}</div>
          
          <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
            <div className="bg-white/10 backdrop-blur rounded-lg px-3 py-2 border border-white/10">
              <div className="text-indigo-200 text-[10px] mb-0.5">Hectares</div>
              <div className="font-semibold">{(totalArea / 10000).toFixed(3)}</div>
            </div>
            <div className="bg-white/10 backdrop-blur rounded-lg px-3 py-2 border border-white/10">
              <div className="text-indigo-200 text-[10px] mb-0.5">Acres</div>
              <div className="font-semibold">{(totalArea * 0.000247105).toFixed(3)}</div>
            </div>
            <div className="bg-white/10 backdrop-blur rounded-lg px-3 py-2 border border-white/10">
              <div className="text-indigo-200 text-[10px] mb-0.5">Est. Plants</div>
              <div className="font-semibold">{Math.round((totalArea / 10000) * TEA_PLANTS_PER_HECTARE).toLocaleString()}</div>
            </div>
            <div className="bg-white/10 backdrop-blur rounded-lg px-3 py-2 border border-white/10">
              <div className="text-indigo-200 text-[10px] mb-0.5">Total Plots</div>
              <div className="font-semibold">{layers.filter(l => l.type === 'polygon' || l.type === 'rectangle').length}</div>
            </div>
          </div>
        </div>

        <div className="mb-5 space-y-3">
          <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Measurement Units</h4>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-gray-600 mb-1 block text-xs">Area Unit</span>
              <select value={areaUnit} onChange={e => setAreaUnit(e.target.value)} className="w-full bg-gray-50 border border-gray-200 text-gray-800 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="metric">Metric (m²/ha)</option>
                <option value="imperial">Imperial (ft²/ac)</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-gray-600 mb-1 block text-xs">Dist Unit</span>
              <select value={distUnit} onChange={e => setDistUnit(e.target.value)} className="w-full bg-gray-50 border border-gray-200 text-gray-800 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="metric">Metric (m/km)</option>
                <option value="imperial">Imperial (ft/mi)</option>
              </select>
            </label>
          </div>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 mb-2">
          <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Satellite size={14} className="text-indigo-500" /> GPS Diagnostics
          </h4>
          <div className="text-sm space-y-2">
            <div className="flex justify-between items-center border-b border-gray-200 pb-2">
              <span className="text-gray-500">Signal Quality</span>
              <span className={`font-bold ${gpsData.accuracy < 5 ? 'text-emerald-500' : gpsData.accuracy < 10 ? 'text-blue-500' : 'text-amber-500'}`}>{gpsData.status}</span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-200 pb-2">
              <span className="text-gray-500">Accuracy</span>
              <span className="font-mono font-medium">{gpsData.accuracy.toFixed(1)} m</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Kalman Samples</span>
              <span className="font-mono font-medium">{gpsData.samples}/8</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bottom-nav">
        {[
          { id: 'draw', icon: PenSquare, label: 'Draw' },
          { id: 'layers', icon: List, label: 'Layers' },
          { id: 'data', icon: Database, label: 'Data' },
          { id: 'info', icon: Info, label: 'Info' }
        ].map(item => (
          <button key={item.id} onClick={() => handleMenuClick(item.id)} className={`nav-btn ${activeTray === item.id ? 'active' : ''}`}>
            <item.icon size={22} className="mb-1" strokeWidth={activeTray === item.id ? 2.5 : 2} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
