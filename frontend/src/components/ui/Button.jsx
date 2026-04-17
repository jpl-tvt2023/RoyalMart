export default function Button({ children, variant = 'primary', size = 'md', className = '', disabled, loading, ...props }) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary:   'bg-[#c1121f] text-white hover:bg-[#a01019] focus:ring-[#c1121f]',
    secondary: 'bg-[#003049] text-white hover:bg-[#00253a] focus:ring-[#003049]',
    outline:   'border border-[#003049] text-[#003049] hover:bg-[#003049] hover:text-white focus:ring-[#003049]',
    ghost:     'text-gray-600 hover:bg-gray-100 focus:ring-gray-300',
    danger:    'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-sm gap-1.5',
    md: 'px-4 py-2 text-sm gap-2',
    lg: 'px-5 py-2.5 text-base gap-2',
  };

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />}
      {children}
    </button>
  );
}
