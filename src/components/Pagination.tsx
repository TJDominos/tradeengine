type PaginationProps = {
  currentPage: number;
  totalItems: number;
  itemsPerPage: number;
  onPageChange: (page: number) => void;
};

export default function Pagination({
  currentPage,
  totalItems,
  itemsPerPage,
  onPageChange,
}: PaginationProps) {
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) return null;

  const first = (currentPage - 1) * itemsPerPage + 1;
  const last = Math.min(currentPage * itemsPerPage, totalItems);

  return (
    <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/50 p-3 text-sm">
      <span className="text-xs text-slate-500">
        Showing {first} to {last} of {totalItems} entries
      </span>
      <div className="flex gap-1">
        <button
          onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
          disabled={currentPage === 1}
          className="rounded bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Prev
        </button>
        <span className="flex items-center px-3 py-1 text-xs font-medium text-slate-400">
          {currentPage} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(currentPage + 1, totalPages))}
          disabled={currentPage === totalPages}
          className="rounded bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}