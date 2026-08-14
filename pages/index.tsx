import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/panel', permanent: false },
});

export default function Index() {
  return null;
}
