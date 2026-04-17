const colorMap = {
  red:    'bg-red-100 text-red-700 border-red-200',
  green:  'bg-green-100 text-green-700 border-green-200',
  blue:   'bg-blue-100 text-blue-700 border-blue-200',
  orange: 'bg-orange-100 text-orange-700 border-orange-200',
  yellow: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  navy:   'bg-[#003049] text-white border-transparent',
  gray:   'bg-gray-100 text-gray-600 border-gray-200',
  purple: 'bg-purple-100 text-purple-700 border-purple-200',
};

export default function Badge({ children, color = 'gray', className = '' }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${colorMap[color] || colorMap.gray} ${className}`}>
      {children}
    </span>
  );
}
